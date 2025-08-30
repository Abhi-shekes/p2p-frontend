"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:4000";
const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CHUNK_SIZE = 64 * 1024; // 64KB

function ProgressBar({ label, progress }) {
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{Math.round(progress)}%</span>
      </div>
      <div className="w-full bg-muted rounded h-2">
        <div
          className="bg-blue-600 h-2 rounded"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
}

function ConnectionStatus({ status }) {
  const color =
    status === "connected"
      ? "text-green-600"
      : status === "transferring"
      ? "text-blue-600"
      : status === "completed"
      ? "text-emerald-600"
      : status === "error"
      ? "text-red-600"
      : "text-amber-600";
  return <div className={`text-sm ${color}`}>Status: {status}</div>;
}

function QRCode({ text }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function generate() {
      if (!text) return;
      const QR = await import("qrcode");
      if (cancelled) return;
      await QR.toCanvas(canvasRef.current, text, { width: 160, margin: 1 });
    }
    generate();
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (!text) return null;
  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        className="border rounded p-1 bg-white"
        aria-label="QR code"
      />
      <span className="text-xs text-muted-foreground break-all">{text}</span>
    </div>
  );
}

export default function HomePage() {
  const [socket, setSocket] = useState(null);
  const [sessionToken, setSessionToken] = useState("");
  const [expiresAt, setExpiresAt] = useState(null);
  const [role, setRole] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | waiting | connected | transferring | completed | error
  const [error, setError] = useState("");
  const [lastAction, setLastAction] = useState("idle"); // 'idle' | 'create' | 'join'
  const [selectedFiles, setSelectedFiles] = useState([]); // New state for selected files

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const sessionTokenRef = useRef(null);
  const recvChunksRef = useRef([]);
  const recvMetaRef = useRef(null);
  const recvBytesRef = useRef(0);

  const tokenInputRef = useRef(null);
  const socketRef = useRef(null);
  const roleRef = useRef(null);
  const [expiresIn, setExpiresIn] = useState("");
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sendProgress, setSendProgress] = useState(0); // Track overall progress for multiple files
  const [currentFileIndex, setCurrentFileIndex] = useState(0); // Track which file is being sent

  const ensureSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.connected) return socketRef.current;
    if (!socketRef.current) {
      const s = io(SIGNALING_URL, {
        transports: ["websocket"],
        autoConnect: true,
      });
      socketRef.current = s;
      setSocket(s);
    } else if (!socketRef.current.connected) {
      try {
        socketRef.current.connect();
      } catch {}
    }
    return socketRef.current;
  }, [setSocket]);

  const cleanupRTC = useCallback(() => {
    try {
      if (dcRef.current) {
        dcRef.current.onopen = null;
        dcRef.current.onmessage = null;
        dcRef.current.onclose = null;
        dcRef.current.onerror = null;
        dcRef.current.close();
      }
      dcRef.current = null;
      if (pcRef.current) {
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.ondatachannel = null;
        pcRef.current.close();
      }
      pcRef.current = null;
    } catch {}
  }, []);

  const resetState = useCallback(() => {
    setStatus("idle");
    setError("");
    setRole(null);
    roleRef.current = null;
    setSendProgress(0);
    setRecvProgress(0);
    setExpiresAt(null);
    setLastAction("idle");
    setSelectedFiles([]); // Reset selected files
    setCurrentFileIndex(0);
    recvChunksRef.current = [];
    recvMetaRef.current = null;
    recvBytesRef.current = 0;
    try {
      if (socketRef.current) {
        socketRef.current.emit("session-cancel", { token: sessionToken });
        socketRef.current.removeAllListeners();
      }
    } catch {}
    cleanupRTC();
  }, [cleanupRTC, sessionToken]);

  useEffect(() => {
    return () => {
      try {
        cleanupRTC();
      } catch {}
      try {
        socketRef.current?.disconnect();
      } catch {}
    };
  }, [cleanupRTC]);

  async function createSession() {
    try {
      resetState();
      setLastAction("create");
      const res = await fetch(`${SIGNALING_URL}/api/create-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to create session");
      const data = await res.json();
      setSessionToken(data.token);
      sessionTokenRef.current = data.token;
      setExpiresAt(data.expiresAt);
      setStatus("waiting");

      const s = ensureSocket();
      s.once("connect_error", () => {
        setError("Failed to connect to signaling server.");
        setStatus("error");
      });
      wireSocketEvents(s);
      s.emit("register", { token: data.token });
    } catch (e) {
      setError(e.message || "Create session failed");
      setStatus("error");
    }
  }

  function joinSession() {
    try {
      resetState();
      setLastAction("join");
      const token = tokenInputRef.current?.value?.trim();
      if (!token || !isValidToken(token)) {
        setError("Invalid token.");
        setStatus("error");
        return;
      }
      setSessionToken(token);
      sessionTokenRef.current = token;
      setStatus("waiting");

      const s = ensureSocket();
      s.once("connect_error", () => {
        setError("Failed to connect to signaling server.");
        setStatus("error");
      });
      wireSocketEvents(s);
      s.emit("register", { token });
    } catch {
      setError("Join session failed");
      setStatus("error");
    }
  }

  function wireSocketEvents(s) {
    s.removeAllListeners("registered");
    s.removeAllListeners("ready");
    s.removeAllListeners("signal");
    s.removeAllListeners("error-message");
    s.removeAllListeners("session-destroyed");
    s.removeAllListeners("connect_error");
    s.removeAllListeners("disconnect");

    s.on("connect_error", () => {
      setError("Failed to connect to signaling server.");
      setStatus("error");
    });
    s.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") {
        setError("Disconnected from signaling server.");
        if (status !== "completed") setStatus("error");
      }
    });

    s.on("registered", ({ role: r, expiresAt: exp }) => {
      setRole(r);
      roleRef.current = r;
      if (exp) setExpiresAt(exp);
    });

    s.on("ready", () => {
      if (sessionTokenRef.current && isValidToken(sessionTokenRef.current)) {
        startWebRTC();
      } else {
        console.error("Session token not ready:", sessionTokenRef.current);
        setError("Session token not ready. Please try again.");
        setStatus("error");
      }
    });

    s.on("signal", async ({ type, data }) => {
      const pc = pcRef.current;
      if (!pc) return;
      if (type === "offer") {
        await pc.setRemoteDescription(data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        s.emit("signal", {
          token: sessionTokenRef.current,
          type: "answer",
          data: pc.localDescription,
        });
      } else if (type === "answer") {
        await pc.setRemoteDescription(data);
      } else if (type === "ice") {
        try {
          await pc.addIceCandidate(data);
        } catch {}
      }
    });

    s.on("error-message", ({ message }) => {
      setError(message || "Signaling error");
      setStatus("error");
    });

    s.on("session-destroyed", () => {
      setStatus("completed");
      cleanupRTC();
    });
  }

  async function startWebRTC() {
    const token = sessionTokenRef.current;
    console.log("Starting WebRTC with token:", token);
    if (!token || !isValidToken(token)) {
      console.error("Invalid or missing sessionToken:", token);
      setError("Invalid session token. Please try again.");
      setStatus("error");
      return;
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      pcRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("Emitting ICE candidate with token:", token);
          socketRef.current?.emit("signal", { token, type: "ice", data: event.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setStatus("connected");
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setStatus("error");
        }
      };

      if (roleRef.current === "host") {
        const dc = pc.createDataChannel("file", { ordered: true });
        bindDataChannel(dc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log("Emitting offer with token:", token);
        socketRef.current?.emit("signal", { token, type: "offer", data: pc.localDescription });
      } else {
        pc.ondatachannel = (event) => {
          const dc = event.channel;
          bindDataChannel(dc);
        };
      }
    } catch (err) {
      console.error("WebRTC init error:", err);
      setError("WebRTC init failed");
      setStatus("error");
    }
  }

  function isValidToken(token) {
    if (typeof token !== "string") return false;
    if (token.length !== 16) return false;
    return /^[A-Fa-f0-9]+$/.test(token);
  }

  function bindDataChannel(dc) {
    dcRef.current = dc;
    dc.bufferedAmountLowThreshold = CHUNK_SIZE * 4;
    dc.onopen = () => {
      setStatus("connected");
    };
    dc.onclose = () => {};
    dc.onerror = () => {
      setError("Data channel error");
      setStatus("error");
    };

    dc.onmessage = (evt) => {
      if (typeof evt.data === "string") {
        try {
          const meta = JSON.parse(evt.data);
          if (meta && meta.type === "meta" && meta.name && meta.size != null) {
            recvMetaRef.current = meta;
            recvChunksRef.current = [];
            recvBytesRef.current = 0;
            setRecvProgress(0);
            setStatus("transferring");
          }
        } catch {
          // ignore
        }
      } else if (evt.data instanceof ArrayBuffer || evt.data?.byteLength >= 0) {
        const maybePromise = evt.data instanceof ArrayBuffer ? evt.data : evt.data.arrayBuffer();
        if (maybePromise.then) {
          maybePromise.then(storeChunk);
        } else {
          storeChunk(maybePromise);
        }
      }
    };

    function storeChunk(arrayBuffer) {
      recvChunksRef.current.push(new Uint8Array(arrayBuffer));
      recvBytesRef.current += arrayBuffer.byteLength;
      const total = recvMetaRef.current?.size || 1;
      setRecvProgress((recvBytesRef.current / total) * 100);

      if (recvMetaRef.current && recvBytesRef.current >= recvMetaRef.current.size) {
        const blob = new Blob(recvChunksRef.current, {
          type: recvMetaRef.current.mime || "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = recvMetaRef.current.name || "download";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setStatus("completed");
        socketRef.current?.emit("session-complete", { token: sessionTokenRef.current });
      }
    }
  }

  const [recvProgress, setRecvProgress] = useState(0);

  async function onPickFile(e) {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(files); // Store selected files
  }

  async function sendFiles() {
    if (!selectedFiles.length || !dcRef.current || dcRef.current.readyState !== "open") {
      setError("No files selected or connection not ready.");
      return;
    }
    setStatus("transferring");
    setSendProgress(0);
    setCurrentFileIndex(0);

    for (let i = 0; i < selectedFiles.length; i++) {
      await sendFile(selectedFiles[i], i === selectedFiles.length - 1); // Send each file
    }
  }

  async function sendFile(file, isLast) {
    try {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") {
        setError("Waiting for peer connection...");
        return;
      }

      const meta = {
        type: "meta",
        name: file.name,
        size: file.size,
        mime: file.type,
        chunkSize: CHUNK_SIZE,
      };
      dc.send(JSON.stringify(meta));

      let offset = 0;
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const arrayBuffer = await chunk.arrayBuffer();

        if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
          await new Promise((resolve) => {
            const handler = () => {
              dc.removeEventListener("bufferedamountlow", handler);
              resolve();
            };
            dc.addEventListener("bufferedamountlow", handler, { once: true });
          });
        }

        dc.send(arrayBuffer);
        offset += arrayBuffer.byteLength;
        const totalBytes = selectedFiles.reduce((sum, f) => sum + f.size, 0);
        const sentBytes = selectedFiles
          .slice(0, currentFileIndex)
          .reduce((sum, f) => sum + f.size, 0) + offset;
        setSendProgress((sentBytes / totalBytes) * 100);
      }

      if (isLast) {
        setStatus("completed");
        setSelectedFiles([]);
        setCurrentFileIndex(0);
        socketRef.current?.emit("session-complete", { token: sessionTokenRef.current });
      } else {
        setCurrentFileIndex(currentFileIndex + 1);
      }
    } catch {
      setError("Send failed");
      setStatus("error");
    }
  }

  function onDropFile(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!dcRef.current || dcRef.current.readyState !== "open") return;
    const files = Array.from(e.dataTransfer?.files || []);
    setSelectedFiles(files);
  }

  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function onDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function cancelTransfer() {
    try {
      if (dcRef.current && dcRef.current.readyState === "open") {
        dcRef.current.close();
      }
      cleanupRTC();
      setStatus("idle");
      setSelectedFiles([]);
      setCurrentFileIndex(0);
    } catch {}
  }

  function copyToken() {
    if (!sessionToken) return;
    navigator.clipboard.writeText(sessionToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  useEffect(() => {
    function updateCountdown() {
      if (!expiresAt) return setExpiresIn("");
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) return setExpiresIn("expired");
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setExpiresIn(`${m}m ${s}s`);
    }
    const t = setInterval(updateCountdown, 1000);
    updateCountdown();
    function onOffline() {
      setError("You are offline");
      setStatus("error");
    }
    function onOnline() {
      setError("");
      if (status === "error") setStatus("idle");
    }
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(t);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [expiresAt, status]);

  const shareText = useMemo(() => {
    const isHost = roleRef.current === "host";
    const showCreateDetails = lastAction === "create" || isHost;
    if (!sessionToken || !showCreateDetails) return "";
    return sessionToken;
  }, [sessionToken, lastAction]);

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <div className="max-w-xl mx-auto px-6 py-10 flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-balance">Secure P2P File Transfer</h1>
          <p className="text-sm text-muted-foreground">
            End-to-end encrypted with WebRTC DataChannels. No files stored on the server.
          </p>
          <ol className="text-xs text-muted-foreground flex gap-3 flex-wrap">
            <li>1) Create or join session</li>
            <li>2) Connect</li>
            <li>3) Select and send files</li>
          </ol>
        </header>

        <section className="flex flex-col gap-4 p-4 border rounded-lg">
          <h2 className="font-semibold">Create a Session</h2>
          <div className="flex items-center gap-3">
            <button
              className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={createSession}
            >
              Create Session
            </button>
            <ConnectionStatus status={status} />
          </div>

          {(() => {
            const isHost = roleRef.current === "host";
            const showCreateDetails = (lastAction === "create" || isHost) && !!sessionToken;
            if (!showCreateDetails) return null;
            return (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 px-3 py-2 rounded border bg-background"
                    value={sessionToken}
                    readOnly
                    aria-label="Session token"
                  />
                  <button
                    className="px-3 py-2 rounded border"
                    onClick={copyToken}
                    aria-live="polite"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="flex items-start gap-4">
                  <QRCode text={shareText} />
                  <div className="text-xs text-muted-foreground">
                    Share this token with the receiver.{" "}
                    {expiresIn ? `Expires in ${expiresIn}.` : "Expires in 10 minutes."}
                  </div>
                </div>
              </div>
            );
          })()}
        </section>

        <section className="flex flex-col gap-4 p-4 border rounded-lg">
          <h2 className="font-semibold">Join a Session</h2>
          <div className="flex items-center gap-2">
            <input
              ref={tokenInputRef}
              className="flex-1 px-3 py-2 rounded border bg-background"
              placeholder="Enter session token"
              maxLength={16}
            />
            <button
              className="px-4 py-2 rounded bg-foreground text-background hover:opacity-90"
              onClick={joinSession}
            >
              Join
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-4 p-4 border rounded-lg">
          <h2 className="font-semibold">Transfer</h2>

          {(() => {
            const canSend =
              !!dcRef.current &&
              dcRef.current.readyState === "open" &&
              roleRef.current === "host" &&
              status !== "completed";
            const waiting = status === "waiting" || status === "idle";
            return (
              <>
                <div className="text-xs text-muted-foreground">
                  {canSend
                    ? "Connected. You can select and send files now."
                    : waiting
                    ? "Waiting for peer to connect..."
                    : status === "connected"
                    ? "Channel open soon..."
                    : null}
                </div>
                {roleRef.current === "host" && status !== "completed" && (
                  <div className="flex flex-col gap-3">
                    <label className="text-sm">Select files to send</label>
                    <div className="flex gap-2">
                      <input
                        type="file"
                        multiple // Enable multiple file selection
                        onChange={onPickFile}
                        className="px-3 py-2 rounded border bg-background"
                        disabled={!canSend}
                        aria-label="Select files"
                      />
                      <button
                        className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
                        onClick={sendFiles}
                        disabled={!canSend || !selectedFiles.length}
                        aria-disabled={!canSend || !selectedFiles.length}
                      >
                        Send
                      </button>
                    </div>
                    {selectedFiles.length > 0 && (
                      <div className="text-sm">
                        Selected files: {selectedFiles.map((f) => f.name).join(", ")}
                      </div>
                    )}
                    {sendProgress > 0 && <ProgressBar label="Upload" progress={sendProgress} />}

                    <div className="flex gap-2">
                      <button
                        className="px-3 py-2 rounded border"
                        onClick={cancelTransfer}
                        disabled={status !== "transferring" && status !== "connected"}
                        aria-disabled={status !== "transferring" && status !== "connected"}
                      >
                        Cancel
                      </button>
                      <button className="px-3 py-2 rounded border" onClick={resetState}>
                        Reset
                      </button>
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {recvProgress > 0 && <ProgressBar label="Download" progress={recvProgress} />}

          {error && (
            <div className="text-sm text-red-600" role="alert">
              Error: {error}
            </div>
          )}
        </section>

        <footer className="text-xs text-muted-foreground">
          Signaling: {SIGNALING_URL} • STUN: stun.l.google.com:19302
        </footer>
      </div>
    </main>
  );
}