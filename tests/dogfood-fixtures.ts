export interface ThreadDef {
  type: 'customer' | 'reply' | 'customer-follow-up';
  text: string;
}

export interface ConversationDef {
  customerEmail: string;
  customerId?: number;
  subject: string;
  status: string;
  tags: string[];
  threads: ThreadDef[];
  assigneeId?: number;
  reportFixture?: boolean;
  createdAtDaysAgo?: number;
  closedAtDaysAgo?: number;
}

export const INTEGRATION_CONSTANTS = {
  orgId: '33911683',
  orgName: 'Meridian Testing Corp',
  inboxId: '359402',
  userId: 887476,
  searchPrefix: 'MCP-TEST:',
  tag: 'mcp-test',
};

export const INTEGRATION_SEED_CONVERSATIONS: ConversationDef[] = [
  {
    customerEmail: 'aria.chen@meridian-testing.com',
    customerId: 860612497,
    subject: 'MCP-TEST: Report fixture login credentials',
    tags: ['mcp-test'],
    status: 'closed',
    assigneeId: INTEGRATION_CONSTANTS.userId,
    reportFixture: true,
    createdAtDaysAgo: 6,
    closedAtDaysAgo: 6,
    threads: [
      {
        type: 'customer',
        text: "Hi support, I've been unable to log into the client dashboard since yesterday morning. I've tried resetting my password three times but keep getting an 'invalid credentials' error. My username is aria.chen@meridian-testing.com. Can you help?",
      },
      {
        type: 'reply',
        text: "Hi Aria, I've reset your credentials and confirmed your account is active. Please try logging in again at dashboard.meridian-testing.com. If you're still having issues, let me know and I'll set up a screen share.",
      },
    ],
  },
  {
    customerEmail: 'marcus.j@meridian-testing.com',
    customerId: 860612501,
    subject: 'MCP-TEST: Billing question about annual plan',
    tags: ['mcp-test', 'billing'],
    status: 'active',
    createdAtDaysAgo: 5,
    threads: [
      {
        type: 'customer',
        text: "Hey there, our team has been on the monthly plan for about six months now. We'd like to switch to annual billing to get the discount. Can you walk me through what that process looks like? Also wondering if we get prorated credit for the current month.",
      },
    ],
  },
  {
    customerEmail: 'kenji@meridian-testing.com',
    customerId: 860612517,
    subject: 'MCP-TEST: API rate limiting errors',
    tags: ['mcp-test'],
    status: 'pending',
    createdAtDaysAgo: 4,
    threads: [
      {
        type: 'customer',
        text: "We're hitting 429 rate limit errors on the search endpoint during peak hours. Our integration makes about 200 requests per minute. Is there a way to increase our rate limit, or should we implement request queuing on our side?",
      },
      {
        type: 'reply',
        text: "Hi Kenji, I've checked your API usage and you're hitting the 400 req/min limit. I can bump your account to the higher tier which allows 800 req/min. In the meantime, implementing exponential backoff would help smooth out the peaks.",
      },
    ],
  },
  {
    customerEmail: 'priya@meridian-testing.com',
    customerId: 860612506,
    subject: 'MCP-TEST: Report fixture dark mode review',
    tags: ['mcp-test', 'feature-request'],
    status: 'closed',
    assigneeId: INTEGRATION_CONSTANTS.userId,
    reportFixture: true,
    createdAtDaysAgo: 3,
    closedAtDaysAgo: 3,
    threads: [
      {
        type: 'customer',
        text: "Our design team has been requesting a dark mode option for the dashboard. Several of our engineers work late hours and the bright interface causes eye strain. Would this be something on your roadmap?",
      },
      {
        type: 'reply',
        text: "Hi Priya, thanks for the detailed request. I've linked your feedback to our product tracking item and added your design team's use case so the team can evaluate it with the next accessibility pass.",
      },
    ],
  },
  {
    customerEmail: 'tomas.r@meridian-testing.com',
    customerId: 860612508,
    subject: 'MCP-TEST: Data export CSV failure',
    tags: ['mcp-test'],
    status: 'active',
    createdAtDaysAgo: 2,
    threads: [
      {
        type: 'customer',
        text: "The CSV export feature fails when trying to export datasets larger than 10,000 rows. We get a timeout error after about 30 seconds. This is blocking our quarterly reporting workflow.",
      },
      {
        type: 'reply',
        text: "Hi Tomás, thanks for reporting this. I can reproduce the timeout on large exports. I've filed this as a bug with our engineering team. As a workaround, you can use the API endpoint /v2/export with pagination to pull data in chunks.",
      },
      {
        type: 'customer-follow-up',
        text: "Thanks for the workaround. Quick follow-up: we're also seeing the same timeout when exporting from the analytics dashboard, even with smaller datasets around 5,000 rows. Might be related?",
      },
    ],
  },
  {
    customerEmail: 'leah.patel@meridian-testing.com',
    subject: 'MCP-TEST: Report fixture renewal confirmation',
    tags: ['mcp-test', 'billing'],
    status: 'closed',
    assigneeId: INTEGRATION_CONSTANTS.userId,
    reportFixture: true,
    createdAtDaysAgo: 1,
    closedAtDaysAgo: 1,
    threads: [
      {
        type: 'customer',
        text: 'Can you confirm that our renewal settings are correct before the quarterly invoice is generated?',
      },
      {
        type: 'reply',
        text: 'Hi Leah, I confirmed the renewal settings and your quarterly invoice will use the annual contract terms already on file.',
      },
    ],
  },
];

export const INTEGRATION_CONVERSATIONS = INTEGRATION_SEED_CONVERSATIONS.map((conversation) => ({
  customerEmail: conversation.customerEmail,
  subject: conversation.subject,
  tags: conversation.tags,
  status: conversation.status,
  hasStaffReply: conversation.threads.some((thread) => thread.type === 'reply'),
}));
