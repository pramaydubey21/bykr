import { withUser } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import DataTable from "../_components/DataTable";

export const dynamic = "force-dynamic";

type Row = {
  audit_id: number;
  attempted_at: Date;
  alert_id: number;
  recipient_id: number;
  recipient_kind: string | null;
  recipient: string | null;
  outcome: string;
};

/**
 * alert_audit is append-only (REVOKE UPDATE, DELETE + trg_alert_audit_append_only)
 * and readable only by admins (pol_alert_audit_select). It has no foreign keys,
 * so the LEFT JOIN shows "(deleted)" for recipients that no longer exist.
 */
export default async function AdminAudit() {
  const adminId = await requireAdmin();
  const rows = await withUser(adminId, async (db) => {
    const { rows } = await db.query<Row>(
      `SELECT aa.audit_id, aa.attempted_at, aa.alert_id, aa.recipient_id,
              ar.recipient_kind,
              COALESCE(u.full_name, ec.contact_name, au.authority_name) AS recipient,
              aa.outcome
         FROM alert_audit aa
         LEFT JOIN alert_recipient   ar ON ar.recipient_id = aa.recipient_id
         LEFT JOIN app_user          u  ON u.user_id       = ar.user_id
         LEFT JOIN emergency_contact ec ON ec.contact_id   = ar.contact_id
         LEFT JOIN authority         au ON au.authority_id = ar.authority_id
        ORDER BY aa.audit_id DESC
        LIMIT 500`,
    );
    return rows;
  });

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">Alert audit log</h2>
      <p className="mb-4 text-sm text-neutral-500">
        One row per delivery attempt written by <code>sp_dispatch_alert</code>. Append-only. Latest 500 shown.
      </p>
      <DataTable
        columns={["audit_id", "attempted_at", "alert_id", "recipient_id", "kind", "recipient", "outcome"]}
        rows={rows.map((r) => [
          r.audit_id,
          new Date(r.attempted_at).toLocaleString(),
          r.alert_id,
          r.recipient_id,
          r.recipient_kind ?? "(deleted)",
          r.recipient,
          r.outcome,
        ])}
        empty="No dispatch attempts recorded yet."
      />
    </section>
  );
}
