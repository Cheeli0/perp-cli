import { useEffect, useRef } from "react";
// Static import: the library must be safe to evaluate during server prerendering (no globals at load).
import { startFundingCompare } from "../../ws-funding-compare-browser/app.js";

export default function FundingCompare() {
  const root = useRef(null);
  useEffect(() => {
    const stop = startFundingCompare(root.current);
    return () => { void stop(); };
  }, []);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: 16 }}>
      <h1>perp-cli/ws — live funding compare (Next 13.5)</h1>
      <div ref={root} />
    </main>
  );
}
