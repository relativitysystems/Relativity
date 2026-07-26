'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEmailBody } = require('../services/emailNormalizationService');

// EM10 (EMAIL_INGESTION.md §19, §31's EM10 entry) — the milestone's own
// acceptance criteria calls for "a defined fixture set (real anonymized
// thread samples) shows quoted-content stripped in ≥90% of cases without
// stripping genuine new content — a measured, not just asserted, bar."
//
// HONESTY NOTE (consistent with every prior EM record's own "Not
// implemented" section in EMAIL_INGESTION.md): no live Gmail/Outlook
// dogfooding has ever been exercised against a real account anywhere in
// this project — every EM record through EM9 documents that same
// limitation for its own claims. There is therefore no literal "real
// anonymized thread sample" corpus to draw from. The fixtures below are
// instead built to match REAL, publicly documented Gmail/Outlook markup
// conventions as precisely as this codebase's own research allows (Gmail's
// `gmail_quote`/`gmail_attr` div structure, Outlook's `divRplyFwdMsg`+
// `<hr>`+From/Sent/To/Subject header block, Outlook's plain-text
// "-----Original Message-----" convention, common mobile-client signature
// footers) rather than being literal captures from EM6/EM7 dogfooding —
// representative, not live-sourced. This is flagged here explicitly rather
// than silently presented as real data.
//
// Each fixture asserts BOTH halves of the acceptance bar at once: the
// normalized output must contain every string in `mustContain` (genuine new
// content survived) and must contain none of `mustNotContain` (quoted/
// signature content was actually stripped). A fixture only counts as a pass
// if both halves hold.

const FIXTURES = [
  {
    name: 'Gmail HTML reply — gmail_quote div wrapping a blockquote + "On ... wrote:" attribution',
    html: `<div dir="ltr">Sounds good, let's move forward with the Q3 renewal at net-30.<br></div>
<div class="gmail_quote">
  <div dir="ltr" class="gmail_attr">On Tue, Jul 21, 2026 at 3:14 PM John Doe &lt;<a href="mailto:john@vendor.com">john@vendor.com</a>&gt; wrote:<br></div>
  <blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">
    <div dir="ltr">Here are the renewal terms for your review: net-30, 12-month term, auto-renew unless cancelled.</div>
  </blockquote>
</div>`,
    mustContain: ['Q3 renewal at net-30'],
    mustNotContain: ['John Doe', 'renewal terms for your review', 'auto-renew unless cancelled'],
  },
  {
    name: 'Gmail HTML reply-to-a-reply (nested two-level quote) — only the newest message survives',
    html: `<div dir="ltr">Confirmed, thanks!<br></div>
<div class="gmail_quote">
  <div dir="ltr" class="gmail_attr">On Wed, Jul 22, 2026 at 9:00 AM Jane Smith &lt;jane@client.com&gt; wrote:<br></div>
  <blockquote class="gmail_quote">
    <div dir="ltr">Works for me too.<br></div>
    <div class="gmail_quote">
      <div dir="ltr" class="gmail_attr">On Tue, Jul 21, 2026 at 3:14 PM John Doe &lt;john@vendor.com&gt; wrote:<br></div>
      <blockquote class="gmail_quote"><div dir="ltr">Original terms proposal here.</div></blockquote>
    </div>
  </blockquote>
</div>`,
    mustContain: ['Confirmed, thanks'],
    mustNotContain: ['Works for me too', 'Jane Smith', 'Original terms proposal'],
  },
  {
    name: 'Outlook HTML reply — divRplyFwdMsg + From/Sent/To/Subject header + blockquote (EM10 fix)',
    html: `<div>Thanks, that works — please proceed.</div>
<div id="appendonsend"></div>
<hr style="display:inline-block;width:98%" tabindex="-1">
<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> John Doe &lt;john@vendor.com&gt;<br>
<b>Sent:</b> Tuesday, July 21, 2026 3:14 PM<br>
<b>To:</b> Jane Smith &lt;jane@client.com&gt;<br>
<b>Subject:</b> RE: Renewal Terms</font>
<div>&nbsp;</div>
</div>
<blockquote style="border-top:none;border-left:1pt solid rgb(204,204,204);padding:3pt 0in 0in 0.8in">
<div>Here are the proposed renewal terms for your approval.</div>
</blockquote>`,
    mustContain: ['Thanks, that works'],
    mustNotContain: ['From:', 'Sent:', 'proposed renewal terms for your approval'],
  },
  {
    name: 'Outlook plain-text reply — "-----Original Message-----" header block',
    text: `Looks good, approved on our end.

-----Original Message-----
From: John Doe <john@vendor.com>
Sent: Tuesday, July 21, 2026 3:14 PM
To: Jane Smith <jane@client.com>
Subject: RE: Renewal Terms

Here are the proposed renewal terms for your approval.`,
    mustContain: ['approved on our end'],
    mustNotContain: ['Original Message', 'proposed renewal terms for your approval'],
  },
  {
    name: 'Plain text reply with leading ">"-quoted lines, no header line at all',
    text: `Agreed, let's lock this in.

> Here are the renewal terms:
> - net-30
> - 12 month term`,
    mustContain: ["Agreed, let's lock this in"],
    mustNotContain: ['net-30', '12 month term'],
  },
  {
    name: 'Signature — RFC 3676 "-- " delimiter followed by a name/title/company block',
    text: `Please find the signed contract attached.

--
Jane Smith
VP of Operations, Acme Corp
(555) 123-4567`,
    mustContain: ['signed contract attached'],
    mustNotContain: ['VP of Operations', '555) 123-4567'],
  },
  {
    name: 'Mobile signature — SHORT reply + "Sent from my iPhone" (EM10 fix: the short-message head-empty bug)',
    text: `Sounds good, talk soon.

Sent from my iPhone`,
    mustContain: ['Sounds good, talk soon'],
    mustNotContain: ['Sent from my iPhone'],
  },
  {
    name: 'Mobile signature — "Get Outlook for Android" footer',
    text: `Confirmed, see you at 3pm.

Get Outlook for Android`,
    mustContain: ['Confirmed, see you at 3pm'],
    mustNotContain: ['Get Outlook for Android'],
  },
  {
    name: 'Longer real-world-length legal disclaimer block (EM10 fix: widened 400→700 char cap)',
    text: `The updated MSA is attached for signature.

This email and any attachments are confidential and intended only for the addressee. If you are not the intended recipient, please notify the sender immediately and delete this message. Any unauthorized use, disclosure, or copying of this communication is strictly prohibited.`,
    mustContain: ['updated MSA is attached'],
    mustNotContain: ['intended only for the addressee', 'strictly prohibited'],
  },
  {
    name: 'Gmail-style forwarded message ("---------- Forwarded message ---------") — wrapper commentary kept, forwarded body treated as quoted',
    text: `FYI, see below — looks like they agreed to our terms.

---------- Forwarded message ---------
From: John Doe <john@vendor.com>
Date: Tue, Jul 21, 2026 at 3:14 PM
Subject: Renewal Terms
To: Jane Smith <jane@client.com>

We accept the proposed net-30 terms.`,
    mustContain: ['looks like they agreed to our terms'],
    mustNotContain: ['We accept the proposed net-30 terms'],
  },
  {
    name: 'Genuine multi-paragraph email — every real paragraph survives even though a trivial "Thanks,\\nAlex" signoff is correctly stripped (EM10 fix: the old line-window bug wiped the WHOLE message down to one line here)',
    text: `Hi team,

Here's the summary from today's renewal call: the client wants net-30 terms and a 12-month contract with an auto-renew clause.

Next steps: legal to draft the amendment by Friday.

Thanks,
Alex`,
    mustContain: ['net-30 terms and a 12-month contract', 'legal to draft the amendment'],
    mustNotContain: ['Thanks,\nAlex'], // a genuine, tiny signoff — correctly stripped, not a false-positive concern
  },
  {
    name: 'Edge case — the ENTIRE message is just a mobile signature line (must never strip to empty)',
    text: `Sent from my iPhone`,
    mustContain: ['Sent from my iPhone'],
    mustNotContain: [],
  },
];

test('normalization fixture suite: ≥90% of realistic Gmail/Outlook fixtures both strip quoted/signature content AND preserve genuine new content (EM10 acceptance criteria)', () => {
  const results = FIXTURES.map((fixture) => {
    const output = normalizeEmailBody({ html: fixture.html, text: fixture.text });
    const keepsGenuineContent = fixture.mustContain.every((s) => output.includes(s));
    const stripsQuotedContent = fixture.mustNotContain.every((s) => !output.includes(s));
    return { name: fixture.name, output, pass: keepsGenuineContent && stripsQuotedContent, keepsGenuineContent, stripsQuotedContent };
  });

  const failures = results.filter((r) => !r.pass);
  const passRate = (results.length - failures.length) / results.length;

  if (failures.length > 0) {
    console.error('[emailNormalizationFixtures] failing fixtures:', failures.map((f) => ({
      name: f.name, keepsGenuineContent: f.keepsGenuineContent, stripsQuotedContent: f.stripsQuotedContent, output: f.output,
    })));
  }

  assert.ok(
    passRate >= 0.9,
    `normalization pass rate ${(passRate * 100).toFixed(1)}% is below the ≥90% acceptance bar (${failures.length}/${results.length} fixtures failed)`
  );
});

// Individual per-fixture tests too — the aggregate test above proves the
// measured bar; these make a regression in any ONE fixture immediately
// attributable by name in test output, rather than only visible via the
// aggregate's console.error dump.
FIXTURES.forEach((fixture) => {
  test(`normalization fixture: ${fixture.name}`, () => {
    const output = normalizeEmailBody({ html: fixture.html, text: fixture.text });
    for (const s of fixture.mustContain) {
      assert.ok(output.includes(s), `expected output to contain "${s}"\n--- output ---\n${output}`);
    }
    for (const s of fixture.mustNotContain) {
      assert.ok(!output.includes(s), `expected output to NOT contain "${s}"\n--- output ---\n${output}`);
    }
  });
});
