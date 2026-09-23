// Synthetic input only: never reads a mailbox or modifies Gmail labels.
import { getPlatformProxy } from 'wrangler';

const platform = await getPlatformProxy({ configPath: new URL('./wrangler.probe.jsonc', import.meta.url).pathname, persist: false });
try {
  const result = await platform.env.AI.run('typesafe/jev', {
    state: { subject: 'Urgent contract review', body: 'Please review the contract and reply by 5 PM today.' },
    questions: {
      category: { type: 'choice', instructions: 'Classify the email purpose.', criteria: { billing: 'Invoices and receipts', revenue: 'Seller payouts', development: 'Developer notifications', work: 'Individual business correspondence', information: 'Newsletters', security: 'Authentication and security', other: 'Other' } },
      requires_reply: { type: 'noul', instructions: 'Does the email request a reply?', criteria: { true: 'Reply requested', false: 'No reply requested' } },
      unsolicited_sales: { type: 'noul', instructions: 'Is this unsolicited sales outreach?' },
      priority: { type: 'score', instructions: 'How urgent is this email?', criteria: ['Low', 'Normal', 'High', 'Urgent'] },
    },
  });
  console.log(JSON.stringify(result));
} finally {
  await platform.dispose();
}
