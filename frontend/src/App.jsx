import { BrowserRouter, Routes, Route, Link } from "react-router-dom";

import ThemeToggle from "./components/ThemeToggle";
import Dashboard from "./pages/Dashboard";
import TransferDetail from "./pages/TransferDetail";

export default function App() {
  return (
    <BrowserRouter>
      <header
        className="border-b"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-sm font-semibold">
            Data Transfer Dashboard
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/transfers/:id" element={<TransferDetail />} />
      </Routes>
    </BrowserRouter>
  );
}
