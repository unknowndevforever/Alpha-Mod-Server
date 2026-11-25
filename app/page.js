"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [status, setStatus] = useState(null);
  const [host, setHost] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    const { hostname, port } = window.location;
    setHost(hostname.endsWith(".wasmer.app") || !port ? hostname : `${hostname}:${port}`);
    const load = () => fetch("/api/status").then((r) => r.json()).then((s) => { setStatus(s); setError(false); }).catch(() => setError(true));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "40px 16px" }}>
      <h1 style={{ fontSize: 28, margin: "0 0 4px" }}>recreatecraft server</h1>
      <p style={{ color: "#a0a0a0", marginTop: 0 }}>Minecraft Alpha 1.1.2 (protocol 2) over HTTP</p>

      <section style={box}>
        <div style={{ color: "#a0a0a0" }}>In the game: Multiplayer, then type</div>
        <div style={{ fontSize: 22, color: "#ffff55", margin: "6px 0", wordBreak: "break-all" }}>{host || "..."}</div>
        <div style={{ color: "#a0a0a0", fontSize: 13 }}>Needs the patched recreatecraft jar, vanilla clients can't speak HTTP.</div>
      </section>

      <section style={box}>
        {error && <div style={{ color: "#ff5555" }}>Can't reach the server API.</div>}
        {status && (
          <>
            <div>Players online: {status.online} / {status.max}</div>
            <ul style={{ margin: "8px 0", paddingLeft: 20 }}>
              {status.players.map((p) => (
                <li key={p.name}>{p.name} <span style={{ color: "#808080" }}>at {p.x}, {p.y}, {p.z}</span></li>
              ))}
            </ul>
            <div style={{ color: "#a0a0a0", fontSize: 13 }}>
              Day {status.day} · {status.chunks} chunks in memory · {status.persistent ? "saving to " + status.storage : "no disk: world resets on restart"}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

const box = { background: "#2b2b2b", border: "2px solid #000", boxShadow: "inset 2px 2px #555, inset -2px -2px #111", padding: 16, marginTop: 16 };
