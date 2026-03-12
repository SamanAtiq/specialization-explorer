import { createContext, useContext } from "react";

interface UserContextType {
  userId: string | null;
  email: string | null;
  metadata: Record<string, any> | null;
  isLoading: boolean;
  error: Error | null;
  updateUserProfile: (email?: string, metadata?: Record<string, any>) => Promise<void>;
}

export const UserContext = createContext<UserContextType | undefined>(
  undefined
);




export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}