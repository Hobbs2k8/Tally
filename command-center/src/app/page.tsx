import { CommandCenter } from "@/components/CommandCenter";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";

export default function Home() {
  const p = getProvider();
  const label = p.name === "gemini" ? `Gemini · ${p.model() ?? "auto"}` : p.name === "systemone" ? "System One (stub → rules)" : "Deterministic rules (no API key)";
  return <CommandCenter providerLabel={label} />;
}
