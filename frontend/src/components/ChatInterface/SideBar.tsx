import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSidebar } from "@/providers/sidebar";
import { useNavigate } from "react-router";
import { Separator } from "@/components/ui/separator";
import { useMode } from "@/providers/mode";
import { useView } from "@/providers/view";
import { Plus, MessageSquare, Volume2, ChevronRight } from "lucide-react";
import DeleteChatButton from "./DeleteChatButton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useSpeech } from "@/contexts/SpeechContext";

type SidebarContentProps = {
  setMobileOpen: (open: boolean) => void;
};

function SidebarContent({
  setMobileOpen,
}: SidebarContentProps) {
  const navigate = useNavigate();
  const { mode } = useMode();
  const {
    chatSessions,
    activeChatSessionId,
    setActiveChatSessionId,
    createNewChatSession,
    refreshChatSessions,
  } = useView();
  const { settings, setSettings, voices, speak, cancel } = useSpeech();
  const [audioOpen, setAudioOpen] = useState(false);

  const handleNewChat = async () => {
    const newSession = await createNewChatSession();
    if (newSession) {
      navigate(`/chat`);
      setMobileOpen(false);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveChatSessionId(sessionId);
    navigate(`/chat`);
    setMobileOpen(false);
  };

  // No debug logs here; keep dialog state local

  return (
    <>
      {/* Menu Items */}

      <div className="mb-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="px-3 text-xs font-semibold text-muted-foreground tracking-wide">
            {/* TODO: change later */}
            CHATS
          </h3>
          <Button
            variant="link"
            size="icon"
            onClick={handleNewChat}
            className="text-muted-foreground hover:text-foreground cursor-pointer h-6 w-6"
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Chat sessions list */}
        <div className="pl-2 border-l-2 border-muted space-y-1 max-h-[300px] overflow-y-auto">
          {chatSessions.map((session, index) => (
            <Button
              key={session.id}
              variant="link"
              onClick={() => handleSelectSession(session.id)}
              className={`cursor-pointer w-full justify-start px-3 py-2 text-sm rounded-md transition-colors ${activeChatSessionId === session.id
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:underline"
                }`}
            >
              <MessageSquare className="h-4 w-4 mr-2 flex-shrink-0" />
              {/* temporary place holder for chat names */}
              <span className="truncate">
                {session.name || `Chat ${chatSessions.length - index}`}
              </span>
              {/* Delete icon */}
              <div className="ml-auto">
                <DeleteChatButton
                  chatSessionId={session.id}
                  userId={session.user_id}
                  onDeleted={async () => {
                    // Refresh sessions and if currently active, unset it
                    await refreshChatSessions();
                    if (activeChatSessionId === session.id) {
                      setActiveChatSessionId("");
                    }
                  }}
                />
              </div>
            </Button>
          ))}
        </div>
      </div>
      {/* --- Speech Controls (Dropdown) --- */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2 px-3">
          <div className="flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-xs font-semibold text-muted-foreground tracking-wide">AUDIO</h3>
          </div>
          <Dialog open={audioOpen} onOpenChange={(o) => setAudioOpen(o)}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Audio settings">
                <ChevronRight
                  className={cn(
                    "h-4 w-4 transition-transform duration-150",
                    audioOpen ? "rotate-90" : "rotate-0"
                  )}
                />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm" aria-label="Audio settings dialog">
              <DialogHeader>
                <DialogTitle className="text-sm">Audio settings</DialogTitle>
              </DialogHeader>
              <div className="px-1 py-2 space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Narration</Label>
                  <Switch
                    id="speech-enabled"
                    checked={settings.enabled}
                    onCheckedChange={(v) => setSettings({ enabled: v })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Autoplay</Label>
                  <Switch
                    id="speech-autoplay"
                    checked={settings.autoplay}
                    onCheckedChange={(v) => setSettings({ autoplay: v })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Mode</Label>
                  <Select
                    value={settings.mode}
                    onValueChange={(v) => setSettings({ mode: v as any })}
                  >
                    <SelectTrigger className="w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">Both</SelectItem>
                      <SelectItem value="ai">AI only</SelectItem>
                      <SelectItem value="user">User only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Voice</Label>
                  <Select
                    value={settings.voiceURI || "default"}
                    onValueChange={(v) => setSettings({ voiceURI: v === "default" ? null : v })}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {voices.map((v) => (
                        <SelectItem key={v.voiceURI} value={v.voiceURI || v.name}>
                          {v.name} {v.lang ? `(${v.lang})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-full text-xs">Rate</div>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={settings.rate}
                    onChange={(e) => setSettings({ rate: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-full text-xs">Pitch</div>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={settings.pitch}
                    onChange={(e) => setSettings({ pitch: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-full text-xs">Volume</div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={settings.volume}
                    onChange={(e) => setSettings({ volume: Number(e.target.value) })}
                  />
                </div>
              </div>
              <DialogFooter className="flex gap-2 justify-end">
                <Button onClick={() => speak("This is a sample of the selected voice.", { enabled: true })}>Play sample</Button>
                <Button variant="ghost" onClick={() => cancel()}>
                  Stop
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <Separator className="mb-4" />
      {mode === "student" ? (
        // student view content - placeholder for future navigation
        <nav className="space-y-2 mb-4">
          {/* Future navigation items can be added here */}
        </nav>
      ) : (
        // instructor view content - placeholder for future navigation
        <nav className="space-y-2 mb-4">
          {/* Future navigation items can be added here */}
        </nav>
      )}
    </>
  );
}

export default function SideBar() {
  const { mobileOpen, setMobileOpen } = useSidebar();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block fixed left-0 p-[10px] h-screen w-64 flex-shrink-0 border bg-muted overflow-auto px-4">
        <SidebarContent
          setMobileOpen={setMobileOpen}
        />
      </aside>

      {/* Mobile sidebar */}
      <div
        className={`md:hidden pt-[10px] fixed inset-0 z-40 transition-opacity ${mobileOpen ? "visible" : "pointer-events-none invisible"
          }`}
        inert={!mobileOpen ? true : undefined}
      >
        {/*mobile backdrop */}
        <div
          className={`absolute inset-0 bg-black/40 ${mobileOpen ? "opacity-100" : "opacity-0"
            }`}
          onClick={() => setMobileOpen(false)}
        />

        {/* mobile view Panel */}
        <div
          className={`pt-[70px] absolute left-0  h-full w-64 bg-muted border-r p-4 transform transition-transform ${mobileOpen ? "translate-x-0" : "-translate-x-full"
            }`}
        >
          <SidebarContent
            setMobileOpen={setMobileOpen}
          />
        </div>
      </div>
    </>
  );
}
