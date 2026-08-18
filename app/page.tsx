import AssistantOrb from "@/components/AssistantOrb";
import AssistantConsole from "@/components/AssistantConsole";
import HudStatusPanels from "@/components/HudStatusPanels";
import NativeInteractionBridge from "@/components/NativeInteractionBridge";

export default function Home() {
  return (
    <main className="assistant-shell">
      <AssistantOrb />
      <AssistantConsole />
      <HudStatusPanels />
      <NativeInteractionBridge />
    </main>
  );
}
