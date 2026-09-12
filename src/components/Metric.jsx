import React from "react";

export default function Metric({ icon: Icon, label, value, sub, title }) {
  return (
    <div className="metric" title={title || undefined}>
      <div className="metric-icon"><Icon size={18} /></div>
      <div>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{value}</div>
        {sub && <div className="metric-sub">{sub}</div>}
      </div>
    </div>
  );
}
