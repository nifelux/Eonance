-- Run once in an existing Eonance Supabase project after deploying the referral-team repair.
-- This function is idempotent: it credits only missing referral_rewards rows for completed deposits.
create or replace function public.eonance_reconcile_referral_rewards(p_limit integer default 500)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  deposit_row record;
  referral_member uuid;
  referrer uuid;
  reward_percentage numeric(5,2);
  reward_amount numeric(14,2);
  reward_id uuid;
  referral_level integer;
  scanned integer := 0;
  rewards_created integer := 0;
  amount_credited numeric(14,2) := 0;
begin
  if not public.is_admin_user() and auth.role() <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'Administrator access required');
  end if;
  for deposit_row in
    select id, user_id, amount, reference
    from public.deposits
    where status = 'completed'
    order by approved_at asc nulls last, created_at asc
    limit least(greatest(coalesce(p_limit, 500), 1), 2000)
  loop
    scanned := scanned + 1;
    referral_member := deposit_row.user_id;
    referral_level := 0;
    while referral_level < 3 loop
      select referred_by into referrer from public.profiles where id = referral_member;
      exit when referrer is null;
      referral_level := referral_level + 1;
      select coalesce(max(case
        when key = case referral_level when 1 then 'referral_percent_l1' when 2 then 'referral_percent_l2' else 'referral_percent_l3' end
        and value ~ '^[0-9]+([.][0-9]+)?$' then value::numeric end),
        case referral_level when 1 then 20 when 2 then 2 else 1 end)
      into reward_percentage from public.site_settings;
      reward_amount := round((deposit_row.amount * reward_percentage / 100)::numeric, 2);
      reward_id := null;
      if reward_amount > 0 then
        insert into public.referral_rewards (referrer_id, referred_user_id, level, percentage, amount, source_deposit_id)
        values (referrer, deposit_row.user_id, referral_level, reward_percentage, reward_amount, deposit_row.id)
        on conflict (referrer_id, source_deposit_id, level) do nothing
        returning id into reward_id;
        if reward_id is not null then
          update public.wallets
          set income_balance = income_balance + reward_amount,
              total_referral_bonus = total_referral_bonus + reward_amount,
              total_income = total_income + reward_amount,
              updated_at = now()
          where user_id = referrer;
          insert into public.wallet_transactions (user_id, balance_type, type, amount, description, reference, metadata)
          values (referrer, 'income', 'referral_bonus', reward_amount, 'Eonance referral reward reconciliation: level ' || referral_level, deposit_row.reference, jsonb_build_object('level', referral_level, 'percentage', reward_percentage, 'source_deposit_id', deposit_row.id, 'source', 'referral_reconciliation'));
          rewards_created := rewards_created + 1;
          amount_credited := amount_credited + reward_amount;
        end if;
      end if;
      referral_member := referrer;
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'deposits_scanned', scanned, 'rewards_created', rewards_created, 'amount_credited', amount_credited);
end;
$$;

grant execute on function public.eonance_reconcile_referral_rewards(integer) to authenticated, service_role;
