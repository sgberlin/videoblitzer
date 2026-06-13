import { creditCosts, type CreditAction } from "./credits";
import { createServiceClient } from "../supabase";

export async function enforceCredits(input: { userId: string; projectId?: string; action: CreditAction; isUnlimited: boolean; metadata?: Record<string, unknown> }) {
  const cost = creditCosts[input.action];
  if (input.isUnlimited) return { ok: true, cost: 0, balanceAfter: null as number | null, isUnlimited: true };

  const supabase = createServiceClient();
  if (!supabase) throw new Error("Credit enforcement requires Supabase service role configuration.");

  const { data, error } = await supabase.rpc("debit_credits_atomic", {
    p_user_id: input.userId,
    p_project_id: input.projectId ?? null,
    p_action: input.action,
    p_amount: cost,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw new Error(error.message);
  const result = Array.isArray(data) ? data[0] : data;
  return { ok: Boolean(result?.ok), cost: Number(result?.cost ?? cost), balanceAfter: result?.balance_after ?? null, isUnlimited: Boolean(result?.is_unlimited) };
}

export async function refundCredits(input: { userId: string; projectId?: string; action: CreditAction | string; cost: number; metadata?: Record<string, unknown> }) {
  if (input.cost <= 0) return;
  const supabase = createServiceClient();
  if (!supabase) throw new Error("Credit refund requires Supabase service role configuration.");
  const { error } = await supabase.rpc("refund_credits_atomic", {
    p_user_id: input.userId,
    p_project_id: input.projectId ?? null,
    p_action: `${input.action}_refund`,
    p_amount: input.cost,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw new Error(error.message);
}
