"use client";

import { useEffect, useState } from "react";
import { authDebug, clearStaleAuthErrors } from "../../../lib/auth";
import { clearLoginCooldown } from "../../../lib/loginCooldown";
import { createBrowserSupabaseClient } from "../../../lib/supabase";

export default function AuthCallbackPage() {
  const [message, setMessage] = useState("Checking your sign-in...");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    async function completeSignIn() {
      const supabase = createBrowserSupabaseClient();
      if (!supabase) {
        setExpired(true);
        setMessage("Supabase publishable configuration is required before login can complete.");
        return;
      }

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const { data, error } = await supabase.auth.getSession();
        authDebug("callback getSession", {
          attempt,
          hasSession: Boolean(data.session),
          userEmail: data.session?.user.email,
          currentRoute: window.location.pathname,
        });

        if (error) {
          setExpired(true);
          setMessage(error.message);
          return;
        }

        if (data.session) {
          clearStaleAuthErrors();
          clearLoginCooldown();
          window.location.replace("/dashboard");
          return;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      setExpired(true);
      setMessage("This sign-in link expired or could not be verified. Request a new link.");
    }

    void completeSignIn();
  }, []);

  return <section className="hero"><span className="pill">Private beta</span><h1>{expired ? "Magic link expired" : "Checking your sign-in..."}</h1><p className={expired ? "warning" : "muted"}>{message}</p>{expired && <a className="button" href="/login">Request a new link</a>}</section>;
}
