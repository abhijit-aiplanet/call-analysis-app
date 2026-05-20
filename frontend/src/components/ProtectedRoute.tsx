import { useState } from "react";
import LoginPage from "./LoginPage";

export default function ProtectedRoute({ routeKey, children }: { routeKey: string; children: React.ReactNode }) {
  const storageKey = `auth_${routeKey}`;
  const [isAuth, setIsAuth] = useState(() => localStorage.getItem(storageKey) === "true");

  if (!isAuth) {
    return (
      <LoginPage
        onLogin={() => {
          localStorage.setItem(storageKey, "true");
          setIsAuth(true);
        }}
      />
    );
  }

  return <>{children}</>;
}
