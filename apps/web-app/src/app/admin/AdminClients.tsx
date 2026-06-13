"use client";
import type React from "react";
import { useEffect, useState } from "react";
import { AuthStatusMessage } from "../../components/AuthStatus";
import { apiFetch } from "../../lib/api";
import { type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../lib/auth";

type AdminUser = { email: string; role: string; plan_key: string; is_unlimited: boolean; status?: string; invited_at?: string };
type AdminJob = { id: string; project_id?: string; type?: string; status: string; progress?: number; error?: string; error_message?: string; created_at?: string; source_object_key?: string; target_object_key?: string; output?: Record<string, unknown>; input?: Record<string, unknown> };
type CreditBalance = { user_id: string; balance: number; is_unlimited: boolean; updated_at?: string };
type CreditTransaction = { id: string; user_id: string; action: string; amount: number; balance_after?: number; created_at?: string };

function useAdminData<T>(path: string) {
  const auth = useAuthSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthState>("loading");
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!auth.session?.access_token) return;
    setLoading(true);
    try {
      const response = await apiFetch<T>(path, {}, auth.session.access_token);
      setData(response);
      setError("");
      setAuthStatus("authenticated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Admin request failed.";
      if (isPrivateBetaError(message)) setAuthStatus("unauthorized_email");
      else if (isInvalidLinkError(message)) setAuthStatus("invalid_link");
      else setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setAuthStatus(auth.status);
      setLoading(false);
      return;
    }
    setAuthStatus("authenticated");
    void load();
  }, [auth.session?.access_token, auth.status, path]);

  return { auth, authStatus, loading, data, error, load };
}

function Guard<T>({ state, children }: { state: ReturnType<typeof useAdminData<T>>; children: (data: T, reload: () => Promise<void>) => React.ReactNode }) {
  if (state.auth.status === "loading" || state.loading) return <AuthStatusMessage status="loading" />;
  if (state.authStatus !== "authenticated") return <AuthStatusMessage status={state.authStatus} error={state.auth.error} />;
  if (state.error) return <section className="card"><h1>Owner admin unavailable</h1><p className="warning">{state.error}</p></section>;
  if (!state.data) return null;
  return <>{children(state.data, state.load)}</>;
}

export function AdminUsersClient() {
  const state = useAdminData<{ users: AdminUser[] }>("/admin/users");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [planKey, setPlanKey] = useState("starter_weekly");
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [message, setMessage] = useState("");

  async function addUser(reload: () => Promise<void>) {
    if (!state.auth.session?.access_token) return;
    await apiFetch("/admin/users", { method: "POST", body: JSON.stringify({ email, role, planKey, isUnlimited }) }, state.auth.session.access_token);
    setMessage("Allowed user saved.");
    setEmail("");
    await reload();
  }

  async function deleteUser(userEmail: string, reload: () => Promise<void>) {
    if (!state.auth.session?.access_token) return;
    await apiFetch(`/admin/users/${encodeURIComponent(userEmail)}`, { method: "DELETE" }, state.auth.session.access_token);
    await reload();
  }

  return <Guard state={state}>{(data, reload) => <section className="grid">
    <div className="hero"><span className="pill">Owner only</span><h1>Allowed Users</h1><p className="muted">Manage private beta access, roles, plans, and unlimited owner/admin users.</p></div>
    <div className="card"><h3>Add or update user</h3><div className="grid grid-2"><input className="input" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="user@example.com" /><select className="input" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="member">Member</option><option value="admin">Admin</option></select><input className="input" value={planKey} onChange={(event) => setPlanKey(event.target.value)} placeholder="plan key" /><label className="toggle"><input type="checkbox" checked={isUnlimited} onChange={(event) => setIsUnlimited(event.target.checked)} /> Unlimited credits</label></div><br /><button className="button" onClick={() => void addUser(reload)}>Save allowed user</button><p className="muted">Owner access is reserved for the server-side OWNER_EMAIL bootstrap.</p><p className="muted">{message}</p></div>
    <div className="grid grid-2">{data.users.map((user) => <div className="card" key={user.email}><h3>{user.email}</h3><p>{user.role} · {user.plan_key} · {user.status ?? "active"}</p><p className="muted">Unlimited: {user.is_unlimited ? "yes" : "no"}</p><button className="button secondary" onClick={() => void deleteUser(user.email, reload)}>Remove</button></div>)}</div>
  </section>}</Guard>;
}

export function AdminJobsClient() {
  const state = useAdminData<{ jobs: AdminJob[]; exportJobs: AdminJob[] }>("/admin/jobs");
  const worker = useAdminData<{ worker: { configured: boolean; expectedProcess?: string; note?: string }; queuedJobs: number; processingJobs: number; failedJobs: number; recentExportJobs: AdminJob[] }>("/admin/worker-status");
  async function retry(jobId: string, reload: () => Promise<void>) {
    if (!state.auth.session?.access_token) return;
    await apiFetch(`/admin/jobs/${jobId}/retry`, { method: "POST" }, state.auth.session.access_token);
    await reload();
  }
  return <Guard state={state}>{(data, reload) => {
    const allJobs = [...data.jobs, ...data.exportJobs.map((job) => ({ ...job, type: "export_job" }))];
    const queued = allJobs.filter((job) => job.status === "queued").length;
    const failed = allJobs.filter((job) => job.status === "failed").length;
    return <section className="grid"><div className="hero"><span className="pill">Owner only</span><h1>Jobs And Worker Status</h1><p className="muted">Monitor worker queue health, queued jobs, failed jobs, R2 object keys, conversion output keys, and retry failed work.</p></div>
      {worker.data && <div className="grid grid-3"><div className="card"><h3>Worker</h3><p>{worker.data.worker.configured ? "Queue API configured" : "Queue API unavailable"}</p><p className="muted">{worker.data.worker.expectedProcess ?? "videoblitzer-video-worker"}</p></div><div className="card"><h3>Queue</h3><p>{worker.data.queuedJobs} queued · {worker.data.processingJobs} processing</p></div><div className="card"><h3>Failures</h3><p className={worker.data.failedJobs ? "warning" : "status"}>{worker.data.failedJobs} failed export jobs</p></div></div>}
      <div className="grid grid-3"><div className="card"><h3>Queued jobs</h3><p>{queued}</p></div><div className="card"><h3>Failed jobs</h3><p className={failed ? "warning" : "status"}>{failed}</p></div><div className="card"><h3>Total visible jobs</h3><p>{allJobs.length}</p></div></div>
      <div className="grid grid-2">{allJobs.map((job) => {
        const sourceKey = job.source_object_key ?? String(job.input?.sourceObjectKey ?? "");
        const targetKey = job.target_object_key ?? String(job.input?.targetObjectKey ?? job.output?.targetObjectKey ?? "");
        return <div className="card" key={`${job.type}-${job.id}`}><h3>{job.type ?? "job"} · {job.status}</h3><p className="muted">{job.id}</p><p>Progress: {job.progress ?? "--"}%</p>{sourceKey && <p><strong>R2 source key</strong><br /><span className="muted">{sourceKey}</span></p>}{targetKey && <p><strong>Conversion output key</strong><br /><span className="muted">{targetKey}</span></p>}{(job.error || job.error_message) && <p className="warning">{job.error ?? job.error_message}</p>}<button className="button secondary" disabled={job.status !== "failed"} onClick={() => void retry(job.id, reload)}>Retry failed job</button></div>;
      })}</div></section>;
  }}</Guard>;
}

export function AdminCreditsClient() {
  const state = useAdminData<{ balances: CreditBalance[]; transactions: CreditTransaction[] }>("/admin/credits");
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState(10);
  async function adjust(reload: () => Promise<void>) {
    if (!state.auth.session?.access_token) return;
    await apiFetch("/admin/credits", { method: "POST", body: JSON.stringify({ userId, amount, action: "admin_adjustment" }) }, state.auth.session.access_token);
    await reload();
  }
  return <Guard state={state}>{(data, reload) => <section className="grid"><div className="hero"><span className="pill">Owner only</span><h1>Credits</h1><p className="muted">Review balances, recent transactions, and make manual adjustments.</p></div><div className="card"><div className="grid grid-2"><input className="input" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="Supabase user id" /><input className="input" type="number" value={amount} onChange={(event) => setAmount(Number(event.target.value))} /></div><br /><button className="button" onClick={() => void adjust(reload)}>Adjust credits</button></div><div className="grid grid-2">{data.balances.map((balance) => <div className="card" key={balance.user_id}><h3>{balance.balance} credits</h3><p className="muted">{balance.user_id}</p><p>Unlimited: {balance.is_unlimited ? "yes" : "no"}</p></div>)}</div><div className="card"><h3>Recent transactions</h3>{data.transactions.map((tx) => <p key={tx.id}>{tx.action} · {tx.amount} · balance {tx.balance_after ?? "--"}<br /><span className="muted">{tx.user_id}</span></p>)}</div></section>}</Guard>;
}

export function AdminImportsClient() {
  const state = useAdminData<{ imports: Array<Record<string, unknown>> }>("/admin/imports");
  return <Guard state={state}>{(data) => <section className="grid"><div className="hero"><span className="pill">Owner only</span><h1>Import Audits</h1><p className="muted">Review authorized source import attempts and permission confirmations.</p></div>{data.imports.map((item, index) => <pre className="card" key={index} style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{JSON.stringify(item, null, 2)}</pre>)}</section>}</Guard>;
}

export function AdminLogsClient() {
  const state = useAdminData<{ logs: Array<Record<string, unknown>> }>("/admin/logs");
  return <Guard state={state}>{(data) => <section className="grid"><div className="hero"><span className="pill">Owner only</span><h1>Audit Logs</h1><p className="muted">Server-side audit log records.</p></div>{data.logs.length ? data.logs.map((item, index) => <pre className="card" key={index} style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{JSON.stringify(item, null, 2)}</pre>) : <div className="card"><p className="muted">No audit logs recorded yet.</p></div>}</section>}</Guard>;
}
