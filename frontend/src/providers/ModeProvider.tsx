import { createContext, useState } from "react";
import type { ReactNode } from "react";
import { ModeContext, type Mode } from "./mode";

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("student");
  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ModeContext.Provider>
  );
}

export default ModeProvider;
