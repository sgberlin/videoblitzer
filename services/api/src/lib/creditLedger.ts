import { creditCosts, type CreditAction, validateCredits } from "./credits";
import { createServiceClient } from "../supabase";

export async function enforceCredits(input: { userId: string; projectId?: string; action: CreditAction; isUnlimited: boolean; metadata?: Record<string, unknown> }) {
  const cost = creditCosts[input.action];
  if (input.isUnlimited) return { ok: true, cost: 0, balanceAfter: null as number | null, isUnlimited: true };

  const supabase = createServiceClient();
  if (!supabase) throw new Error("Credit enforcement requires Supabase service role configuration.");

  const { data: current, error: balanceError } = await supabase.from("credit_balances").select("balance,is_unlimited").eq("user_id", input.userId).maybeSingle();
  if (balanceError) throw new Error(balanceError.message);

  const balance = current?.balance ?? 0;
  const isUnlimited = Boolean(current?.is_unlimited);
  const validation = validateCredits(isUnlimited, balance, input.action);
  if (!validation.ok) {
    return { ok: false, cost: validation.cost, balanceAfter: balance, isUnlimited };
  }

  const { error: upsertError } = await supabase.from("credit_balances").upsert({ user_id: input.userId, balance: validation.balanceAfter, is_unlimited: false, updated_at: new Date().toISOString() });
  if (upsertError) throw new Error(upsertError.message);

  const { error: transactionError } = await supabase.from("credit_transactions").insert({
    user_id: input.userId,
    project_id: input.projectId,
    action: input.action,
    amount: -validation.cost,
    balance_after: validation.balanceAfter,
    metadata: input.metadata ?? {},
  });
  if (transactionError) throw new Error(transactionError.message);

  return { ok: true, cost: validation.cost, balanceAfter: validation.balanceAfter, isUnlimited };
}
