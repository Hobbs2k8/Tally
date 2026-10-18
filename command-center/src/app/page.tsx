import { CommandCenter } from "@/components/CommandCenter";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";

export default function Home() {
  const p = getProvider();
  const label = p.name === "gemini" ? `Gemini · ${p.model() ?? "auto"}` : p.name === "systemone" ? (p.model()?.startsWith("local stand-in") ? `System One stand-in · ${p.model()}` : `System One · ${p.model()}`) : "Deterministic rules (no API key)";
  return <CommandCenter providerLabel={label} />;
}
