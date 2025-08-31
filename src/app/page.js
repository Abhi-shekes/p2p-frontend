"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:4000";
const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];
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
  const [recvProgress, setRecvProgress] = useState(0);

  const iceCandidateQueueRef = useRef([]);

  const ensureSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.connected) return socketRef.current;
    if (!socketRef.current) {
      const s = io(SIGNALING_URL, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.5,
      });
      socketRef.current = s;
      setSocket(s);

      s.on("reconnect", (attempt) => {
        console.log(`Reconnected to signaling server after ${attempt} attempts`);
        if (sessionTokenRef.current) {
          s.emit("register", { token: sessionTokenRef.current });
        }
      });

      s.on("reconnect_error", (err) => {
        console.error("Reconnection error:", err);
        setError("Failed to reconnect to signaling server.");
        setStatus("error");
      });
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
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.ondatachannel = null;
        pcRef.current.close();
      }
      pcRef.current = null;
      iceCandidateQueueRef.current = [];
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

    s.on("connect_error", (err) => {
      console.error("Connect error:", err);
      setError("Failed to connect to signaling server.");
      setStatus("error");
    });
    s.on("disconnect", (reason) => {
      console.log("Disconnected:", reason);
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
      try {
        if (type === "offer") {
          await pc.setRemoteDescription(data);
          for (const candidate of iceCandidateQueueRef.current) {
            try {
              await pc.addIceCandidate(candidate);
            } catch {}
          }
          iceCandidateQueueRef.current = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          s.emit("signal", {
            token: sessionTokenRef.current,
            type: "answer",
            data: pc.localDescription,
          });
        } else if (type === "answer") {
          await pc.setRemoteDescription(data);
          for (const candidate of iceCandidateQueueRef.current) {
            try {
              await pc.addIceCandidate(candidate);
            } catch {}
          }
          iceCandidateQueueRef.current = [];
        } else if (type === "ice") {
          if (pc.remoteDescription) {
            try {
              await pc.addIceCandidate(data);
            } catch (err) {
              console.error("Failed to add ICE candidate:", err);
            }
          } else {
            iceCandidateQueueRef.current.push(data);
          }
        }
      } catch (err) {
        console.error("Signal handling error:", err);
        setError("Signaling error: " + err.message);
        setStatus("error");
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
        console.log("Connection state:", pc.connectionState);
        if (pc.connectionState === "connected") {
          setStatus("connected");
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setError("Peer connection failed or disconnected.");
          setStatus("error");
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("ICE connection state:", pc.iceConnectionState);
        if (pc.iceConnectionState === "failed") {
          setError("ICE connection failed. Check network or add TURN servers.");
          setStatus("error");
        } else if (pc.iceConnectionState === "disconnected") {
          setError("ICE connection disconnected.");
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
      setError("WebRTC init failed: " + err.message);
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
      console.log("Data channel open");
      setStatus("connected");
    };
    dc.onclose = () => {
      console.log("Data channel closed");
      if (status === "transferring") {
        setError("Transfer interrupted: data channel closed unexpectedly");
        setStatus("error");
      }
    };
    dc.onerror = (evt) => {
      console.error("Data channel error:", evt);
      setError(`Data channel error: ${evt.message || "Unknown error"}`);
      setStatus("error");
    };

    dc.onmessage = (evt) => {
      try {
        if (typeof evt.data === "string") {
          const meta = JSON.parse(evt.data);
          if (meta && meta.type === "meta" && meta.name && meta.size != null) {
            recvMetaRef.current = meta;
            recvChunksRef.current = [];
            recvBytesRef.current = 0;
            setRecvProgress(0);
            setStatus("transferring");
          }
        } else if (evt.data instanceof ArrayBuffer || evt.data?.byteLength >= 0) {
          const maybePromise = evt.data instanceof ArrayBuffer ? evt.data : evt.data.arrayBuffer();
          if (maybePromise.then) {
            maybePromise.then(storeChunk).catch((err) => {
              console.error("Chunk processing error:", err);
              setError("Error processing received chunk");
              setStatus("error");
            });
          } else {
            storeChunk(maybePromise);
          }
        }
      } catch (err) {
        console.error("Message handling error:", err);
        setError("Error handling received message");
        setStatus("error");
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
      try {
        await sendFile(selectedFiles[i], i === selectedFiles.length - 1); // Send each file
      } catch (err) {
        console.error("Send files error:", err);
        setError("File transfer failed: " + err.message);
        setStatus("error");
        break;
      }
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
    } catch (err) {
      console.error("Send file error:", err);
      throw err;
    }
  }

  function onDropFile(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!dcRef.current || dcRef.current.readyState !== "open" || status !== "connected") {
      setError("Cannot upload files until peer is connected.");
      return;
    }
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

  useEffect(() => {
    let timeoutId;
    if (status === "waiting") {
      timeoutId = setTimeout(() => {
        if (status === "waiting") {
          setError("Connection timeout: peer did not connect in time.");
          setStatus("error");
          resetState();
        }
      }, 5 * 60 * 1000); // 5 minutes timeout for waiting
    }
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [status, resetState]);

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
      status === "connected"; // Ensure status is explicitly "connected"
    const waiting = status === "waiting" || status === "idle";

    return (
      <>
        <div className="text-xs text-muted-foreground">
          {canSend
            ? "Connected. You can select and send files now."
            : waiting
            ? "Waiting for peer to connect..."
            : status === "connected"
            ? "Channel opening..."
            : status === "completed"
            ? "Transfer completed."
            : "Connecting..."}
        </div>
        {roleRef.current === "host" && status !== "completed" && (
          <div className="flex flex-col gap-3">
            <label className="text-sm">Select files to send</label>
            <div className="flex gap-2">
              <input
                type="file"
                multiple
                onChange={onPickFile}
                className="px-3 py-2 rounded border bg-background"
                disabled={!canSend} // Disable until peer is connected
                aria-label="Select files"
                aria-disabled={!canSend}
              />
              <button
                className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                onClick={sendFiles}
                disabled={!canSend || !selectedFiles.length} // Disable until peer is connected and files are selected
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
                className="px-3 py-2 rounded border disabled:opacity-50"
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