import React from "react";
import { Routes, Route } from "react-router-dom";
import Portal from "@/pages/Portal";
import Record from "@/pages/Record";
import NavLive from "@/pages/NavLive";
import Login from "@/pages/Login";
import RequireAuth from "@/components/RequireAuth";

export default function App() {
  return (
    <Routes>
      {/* Login */}
      <Route path="/login" element={<Login />} />

      {/* Public */}
      <Route path="/" element={<Portal />} />

      {/* Protégées */}
      <Route
        path="/record"
        element={
          <RequireAuth>
            <Record />
          </RequireAuth>
        }
      />

      <Route
        path="/nav"
        element={
          <RequireAuth>
            <NavLive />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
