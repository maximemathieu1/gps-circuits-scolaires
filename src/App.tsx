import React from "react";
import { Routes, Route } from "react-router-dom";
import Portal from "@/pages/Portal";
import Record from "@/pages/Record";
import NavLive from "@/pages/NavLive";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Portal />} />
      <Route path="/record" element={<Record />} />
      <Route path="/nav" element={<NavLive />} />
    </Routes>
  );
}

