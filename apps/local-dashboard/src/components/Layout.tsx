import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isHome = location.pathname === "/";

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <Link to="/" className="header-title">
            self<span>tune</span>
          </Link>
          <span className="version">dashboard v0.1</span>
        </div>
        {!isHome && (
          <Link to="/" className="back-link">
            &larr; Overview
          </Link>
        )}
      </header>
      <main className={`main ${isHome ? "main-full" : ""}`}>{children}</main>
    </div>
  );
}
