import { createContext, useContext } from "react";

export type Mode = "student" | "instructor";

type ModeContextValue = {
  mode: Mode;
  setMode: (m: Mode) => void;
};

export const ModeContext = createContext<ModeContextValue | undefined>(
  undefined
);

export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    throw new Error("useMode must be used within a ModeProvider");
  }
  return ctx;
}

export default ModeContext;