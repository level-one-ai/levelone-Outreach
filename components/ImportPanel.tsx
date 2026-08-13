"use client";

import { useState } from "react";
import { Upload } from "lucide-react";

import Modal from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

/**
 * Pastes a contact list into a campaign.
 *
 * Accepts CSV or TSV with a header row — the format every scraper and
 * spreadsheet exports. Column order does not matter; headers are matched by
 * name so an actor's export can be pasted straight in.
 *
 * Everything after this point is handled server-side: verification,
 * deduplication against existing contacts, and enrolment.
 */

const HEADER_ALIASES: Record<string, string> = {
  email: "email",
  "email address": "email",
  work_email: "email",
  name: "contact_name",
  "full name": "contact_name",
  fullname: "contact_name",
  contact_name: "contact_name",
  company: "company_name",
  "company name": "company_name",
  company_name: "company_name",
  website: "website",
  domain: "website",
  linkedin: "linkedin_url",
  "linkedin url": "linkedin_url",
  linkedin_url: "linkedin_url",
  profileurl: "linkedin_url",
};

interface ParsedContact {
  email: string;
  contact_name: string;
  company_name: string;
  website: string;
  linkedin_url: string;
}

/** Splits on tab if present, else comma. Handles simple quoted fields. */
function splitRow(row: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

export function parseContacts(text: string): ParsedContact[] {
  const rows = text.split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) return [];

  const delimiter = rows[0].includes("\t") ? "\t" : ",";
  const headers = splitRow(rows[0], delimiter).map(
    (h) => HEADER_ALIASES[h.toLowerCase().trim()] ?? ""
  );

  if (!headers.includes("email")) return [];

  return rows.slice(1).flatMap((row) => {
    const cells = splitRow(row, delimiter);
    const record: Record<string, string> = {};
    headers.forEach((key, i) => {
      if (key) record[key] = cells[i] ?? "";
    });
    if (!record.email) return [];
    return [
      {
        email: record.email,
        contact_name: record.contact_name ?? "",
        company_name: record.company_name ?? "",
        website: record.website ?? "",
        linkedin_url: record.linkedin_url ?? "",
      },
    ];
  });
}

export default function ImportPanel({
  campaignId,
  campaignTitle,
  onImported,
}: {
  campaignId: string;
  campaignTitle: string;
  onImported: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [allowUnverified, setAllowUnverified] = useState(false);
  const [startSequence, setStartSequence] = useState(true);
  const [busy, setBusy] = useState(false);

  const parsed = parseContacts(text);

  async function submit() {
    if (parsed.length === 0) {
      toast("error", "No rows found. Include a header row with an 'email' column.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/b2b/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaignId,
          contacts: parsed,
          allow_unverified: allowUnverified,
          start_sequence: startSequence,
        }),
      });
      const body = await res.json();

      if (!body?.ok) {
        toast("error", body?.error ?? "Import failed.");
        return;
      }

      const s = body.summary;
      toast(
        "success",
        `${s.enrolled} enrolled · ${s.contactsReused} existing contacts reused · ${s.alreadyInCampaign} already in this campaign · ${s.rejected} rejected.`
      );

      /* Enrolled but not emailed is the one outcome that looks like success
         and is not. Say it separately so it is not lost in the summary. */
      if (startSequence && body.sequence?.started === false && s.enrolled > 0) {
        toast(
          "error",
          `Contacts were enrolled but n8n did not start the sequence — nothing has been emailed. ${body.sequence.error ?? ""}`
        );
      }

      setText("");
      setOpen(false);
      onImported();
    } catch {
      toast("error", "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-ghost btn-sm">
        <Upload className="h-4 w-4" />
        Import
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import contacts"
        description={`Into "${campaignTitle}". Paste CSV or TSV with a header row.`}
        width="max-w-2xl"
      >
        <div className="flex flex-col gap-4">
          <label>
            <span className="field-label">Contacts</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              spellCheck={false}
              placeholder={"email,name,company,website,linkedin\njane@acme.co.uk,Jane Doe,Acme Ltd,acme.co.uk,linkedin.com/in/janedoe"}
              className="field-input font-mono text-fluid-xs"
            />
          </label>

          <p className="text-fluid-xs text-muted">
            {parsed.length > 0
              ? `${parsed.length} contact${parsed.length === 1 ? "" : "s"} detected.`
              : "Recognised columns: email (required), name, company, website, linkedin."}
          </p>

          <label className="flex items-start gap-2.5 text-fluid-sm text-foreground">
            <input
              type="checkbox"
              checked={startSequence}
              onChange={(e) => setStartSequence(e.target.checked)}
              className="mt-1"
            />
            <span>
              Start the n8n sequence immediately
              <span className="block text-fluid-xs text-muted">
                Sends the first cold email and schedules the 2-day and 5-day
                follow-ups.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-fluid-sm text-foreground">
            <input
              type="checkbox"
              checked={allowUnverified}
              onChange={(e) => setAllowUnverified(e.target.checked)}
              className="mt-1"
            />
            <span>
              Import addresses that fail verification
              <span className="block text-fluid-xs text-muted">
                Raises your bounce rate, which is what damages a sending
                domain&apos;s reputation. Leave off unless you know the list.
              </span>
            </span>
          </label>

          <button onClick={submit} disabled={busy} className="btn-primary w-full">
            {busy ? "Importing…" : `Import ${parsed.length || ""} contacts`}
          </button>
        </div>
      </Modal>
    </>
  );
}
