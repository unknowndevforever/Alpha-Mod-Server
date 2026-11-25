export const metadata = {
  title: "recreatecraft server",
  description: "Minecraft Alpha 1.1.2 server for the recreatecraft client",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#1d1d1d", color: "#e0e0e0", fontFamily: "ui-monospace, Consolas, monospace" }}>
        {children}
      </body>
    </html>
  );
}
