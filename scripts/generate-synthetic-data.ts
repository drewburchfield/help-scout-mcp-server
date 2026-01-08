#!/usr/bin/env npx tsx
/**
 * Synthetic Data Generator for Attendee Support Inbox
 * Generates B2C-style conversations for testing
 *
 * Usage: npx tsx scripts/generate-synthetic-data.ts [--dry-run] [--count N]
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  targetMailboxId: 359403, // Attendee Support inbox
  defaultCount: 200,
  rateLimit: 5,
  rateLimitDelay: 200,
  maxRetries: 3,
  retryDelay: 1000,
};

// Synthetic data templates
const CUSTOMER_FIRST_NAMES = [
  'Sarah', 'Mike', 'Emily', 'David', 'Jessica', 'Chris', 'Ashley', 'Matt',
  'Amanda', 'Josh', 'Nicole', 'Ryan', 'Stephanie', 'Brandon', 'Rachel', 'Tyler',
  'Lauren', 'Kevin', 'Megan', 'Andrew', 'Michelle', 'Jason', 'Brittany', 'Brian',
  'Heather', 'Eric', 'Kimberly', 'Justin', 'Amber', 'Nathan', 'Lisa', 'Daniel'
];

const CUSTOMER_LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker'
];

const EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com',
  'protonmail.com', 'aol.com', 'mail.com'
];

const EVENTS = [
  'Summer Music Festival', 'Foodie Fest 2025', 'Tech Conference', 'Marathon Expo',
  'Art Walk Downtown', 'Beer & Wine Festival', 'Comic Con', 'Holiday Market',
  'Jazz in the Park', 'Film Festival', 'Craft Fair', 'Food Truck Rally',
  'Country Music Fest', 'Pride Parade', 'Oktoberfest', 'Taste of the City'
];

interface ConversationTemplate {
  type: 'login_issue' | 'feature_request' | 'bug_report' | 'schedule_question' | 'general_feedback';
  subjects: string[];
  customerMessages: string[];
  staffResponses: string[];
}

const CONVERSATION_TEMPLATES: ConversationTemplate[] = [
  {
    type: 'login_issue',
    subjects: [
      "Can't log in to the app",
      "Login not working",
      "App keeps logging me out",
      "Password reset not working",
      "Account locked - help!",
      "Can't access my tickets"
    ],
    customerMessages: [
      "Hi, I'm trying to log into the {event} app but it keeps saying my password is wrong. I've tried resetting it 3 times but nothing works. My email is {email}. Please help, the event is tomorrow!",
      "The app keeps crashing when I try to log in. I downloaded it from the app store yesterday. Running iOS 17 on my iPhone 14.",
      "I used to be able to log in fine but now it's not working. Did something change? The event is in 2 days and I need to access my schedule.",
      "Every time I enter my password it just spins forever and then says 'Error occurred'. Is the server down?",
      "I forgot which email I used to sign up. Can you help me find my account? I bought tickets for {event}."
    ],
    staffResponses: [
      "Hi! I'm sorry you're having trouble logging in. Let me help you get this sorted out.\n\nCould you try clearing the app cache and logging in again? Here's how:\n1. Go to Settings > Apps > {event}\n2. Tap 'Clear Cache'\n3. Try logging in again\n\nIf that doesn't work, let me know and I'll reset your password manually.",
      "Thanks for reaching out! I've reset your password - please check your email for the reset link. If you don't see it within 5 minutes, check your spam folder.\n\nLet me know if you need anything else!",
      "I can see your account is active and in good standing. Try uninstalling and reinstalling the app - sometimes a fresh install fixes login issues. Make sure you're using the email {email} to log in."
    ]
  },
  {
    type: 'feature_request',
    subjects: [
      "Suggestion: Add dark mode",
      "Feature request - offline maps",
      "Can you add Apple Wallet support?",
      "Would love to see X feature",
      "App improvement idea"
    ],
    customerMessages: [
      "Love the app! Would be great if you could add dark mode - the white background is hard on my eyes at night.",
      "It would be awesome if we could download the map offline. Cell service at {event} last year was terrible and I couldn't navigate.",
      "Can you add Apple Wallet integration for tickets? Would make getting through the gate so much faster!",
      "Great app overall but it would be nice to be able to favorite vendors and get notifications when they're nearby.",
      "Suggestion: Add a feature to share my schedule with friends who are also attending. Would make meeting up easier."
    ],
    staffResponses: [
      "Thanks for the suggestion! Dark mode is actually on our roadmap for the next major release. We appreciate feedback like this - it helps us prioritize features!",
      "Great idea! We've been exploring offline map support. I'll add your vote to this feature request. In the meantime, try screenshotting the map before you arrive.",
      "Apple Wallet integration is something we're actively working on! Stay tuned for updates before the event.",
      "Love this idea! I've passed it along to our product team. Thanks for taking the time to share your thoughts!"
    ]
  },
  {
    type: 'bug_report',
    subjects: [
      "App crashes when viewing map",
      "Schedule won't load",
      "Photos not uploading",
      "Notifications not working",
      "App is very slow"
    ],
    customerMessages: [
      "The app crashes every time I try to view the venue map. I'm on Android 14, Samsung Galaxy S23. Already tried reinstalling.",
      "My schedule shows 'Loading...' forever. I can see other parts of the app fine, just not my personal schedule.",
      "I'm trying to upload photos from {event} but they never go through. Gets stuck at 50% every time.",
      "I enabled notifications but I'm not getting any alerts about schedule changes. Push permissions are enabled in settings.",
      "The app is super laggy - takes 5-10 seconds to switch between tabs. Started happening after the last update."
    ],
    staffResponses: [
      "Sorry to hear about the crashes! This is a known issue on some Samsung devices - our team is working on a fix. In the meantime, try using the web version at events.example.com/app",
      "I've looked into your account and found the issue - your schedule data was corrupted. I've fixed it on our end. Please force-quit the app and reopen it.",
      "Thanks for reporting this! We identified a bug with photo uploads and pushed a fix this morning. Please update your app to the latest version and try again.",
      "I've checked our logs and notifications are being sent correctly. Could you make sure the app has notification permissions enabled in your phone settings (not just in-app)?"
    ]
  },
  {
    type: 'schedule_question',
    subjects: [
      "When does the main stage start?",
      "Question about schedule",
      "What time does {event} open?",
      "Stage times confusion",
      "Is there a schedule change?"
    ],
    customerMessages: [
      "Hi! Quick question - when does the main stage programming start on Saturday? The app shows different times in different places.",
      "I noticed the schedule changed since yesterday. Is the 3pm set still happening or was it moved?",
      "What are the gate opening times for VIP vs general admission? The app just says 'doors open at 4pm'.",
      "Can you confirm the set times for Sunday? Want to make sure I don't miss anything.",
      "Is there parking on site? I can't find any info about it in the app."
    ],
    staffResponses: [
      "Great question! The main stage kicks off at 2pm on Saturday. The discrepancy you saw was an old placeholder - we've updated it now. Refresh the app to see the correct times!",
      "The 3pm set was moved to 4:30pm due to a scheduling conflict. All changes should be reflected in the app now - try refreshing your schedule.",
      "VIP gates open at 2pm, General Admission at 4pm. I'll make sure this is clearer in the app. Thanks for flagging!",
      "Sunday schedule is confirmed! Check the 'Schedule' tab in the app for the full rundown. Everything is locked in."
    ]
  },
  {
    type: 'general_feedback',
    subjects: [
      "Loved the app!",
      "Thanks for a great event!",
      "Feedback from {event}",
      "App review",
      "Best event app I've used"
    ],
    customerMessages: [
      "Just wanted to say the app made {event} so much better! The map was super helpful and I loved being able to build my schedule. 10/10!",
      "Thanks for a great experience! The push notifications about set changes saved me from missing my favorite performer.",
      "Feedback: App worked great but the font was a bit small for me. Otherwise perfect!",
      "First time using an event app and I'm impressed. Made coordinating with my group so easy.",
      "The food vendor feature was clutch - no more wandering around trying to find what I wanted!"
    ],
    staffResponses: [
      "Thanks so much for the kind words! We're thrilled the app helped make your {event} experience better. See you next year! 🎉",
      "So glad to hear that! We work hard on those real-time notifications. Thanks for taking the time to share your feedback!",
      "Thank you for the feedback! We'll look into increasing the font size option. Your input helps us improve!",
      "Made our day! Thanks for letting us know. Hope to see you at future events!"
    ]
  }
];

// Utility functions
function loadEnv(): Record<string, string> {
  const envPath = path.join(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const env: Record<string, string> = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
  return env;
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const response = await axios.post(
    'https://api.helpscout.net/v2/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

function createApiClient(accessToken: string): AxiosInstance {
  return axios.create({
    baseURL: 'https://api.helpscout.net/v2',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateEmail(firstName: string, lastName: string): string {
  const domain = randomChoice(EMAIL_DOMAINS);
  const formats = [
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}`,
    `${firstName.toLowerCase()}${lastName.toLowerCase()}`,
    `${firstName.toLowerCase()}_${lastName.toLowerCase()}`,
    `${firstName.toLowerCase()}${Math.floor(Math.random() * 100)}`,
  ];
  return `${randomChoice(formats)}@${domain}`;
}

function generateRandomDate(daysBack: number = 365): string {
  const now = new Date();
  const past = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const randomTime = past.getTime() + Math.random() * (now.getTime() - past.getTime());
  const date = new Date(randomTime);
  // Format without milliseconds
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function substituteVariables(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

function generateConversation(index: number) {
  const firstName = randomChoice(CUSTOMER_FIRST_NAMES);
  const lastName = randomChoice(CUSTOMER_LAST_NAMES);
  const email = generateEmail(firstName, lastName);
  const event = randomChoice(EVENTS);
  const template = randomChoice(CONVERSATION_TEMPLATES);

  const vars = { event, email };

  const subject = substituteVariables(randomChoice(template.subjects), vars);
  const customerMessage = substituteVariables(randomChoice(template.customerMessages), vars);

  // Randomly decide if this conversation has a staff response
  const hasResponse = Math.random() > 0.2; // 80% have responses
  const staffResponse = hasResponse ? substituteVariables(randomChoice(template.staffResponses), vars) : null;

  // Random status
  const statuses: Array<'active' | 'pending' | 'closed'> = ['active', 'pending', 'closed'];
  const statusWeights = [0.1, 0.1, 0.8]; // 10% active, 10% pending, 80% closed
  const rand = Math.random();
  let status: 'active' | 'pending' | 'closed' = 'closed';
  if (rand < statusWeights[0]) status = 'active';
  else if (rand < statusWeights[0] + statusWeights[1]) status = 'pending';

  const createdAt = generateRandomDate(365);
  const threads: Array<{type: string; text: string; createdAt: string; customer: any}> = [
    {
      type: 'customer',
      text: customerMessage,
      createdAt: createdAt,
      customer: { email, firstName, lastName },
    }
  ];

  if (staffResponse) {
    // Staff response comes a few hours later
    const responseDate = new Date(new Date(createdAt).getTime() + (1 + Math.random() * 4) * 60 * 60 * 1000);
    threads.push({
      type: 'reply',
      text: staffResponse,
      createdAt: responseDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      customer: { email, firstName, lastName },
    });
  }

  return {
    subject,
    type: 'email' as const,
    mailboxId: CONFIG.targetMailboxId,
    status,
    customer: { email, firstName, lastName },
    threads,
    imported: true as const,
    createdAt,
    ...(status === 'closed' ? { closedAt: threads[threads.length - 1].createdAt } : {}),
  };
}

async function createConversation(
  api: AxiosInstance,
  conversation: ReturnType<typeof generateConversation>,
  dryRun: boolean
): Promise<{ success: boolean; error?: string }> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would create: "${conversation.subject}" (${conversation.threads.length} threads)`);
    return { success: true };
  }

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      await api.post('/conversations', conversation);
      return { success: true };
    } catch (error: any) {
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '60');
        console.log(`  Rate limited, waiting ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (attempt === CONFIG.maxRetries) {
        const errorData = error.response?.data;
        const errorMsg = errorData ? JSON.stringify(errorData, null, 2) : error.message;
        return { success: false, error: errorMsg };
      }

      await sleep(CONFIG.retryDelay * attempt);
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const countArg = args.find(a => a.startsWith('--count='));
  const count = countArg ? parseInt(countArg.split('=')[1]) : CONFIG.defaultCount;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Synthetic Data Generator - Attendee Support');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Target Mailbox: ${CONFIG.targetMailboxId} (Attendee Support)`);
  console.log(`  Count: ${count}`);
  console.log(`  Dry Run: ${dryRun}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const env = loadEnv();
  const clientId = env.HELPSCOUT_CLIENT_ID;
  const clientSecret = env.HELPSCOUT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ Missing credentials in .env');
    process.exit(1);
  }

  console.log('🔐 Authenticating...');
  const accessToken = await getAccessToken(clientId, clientSecret);
  const api = createApiClient(accessToken);
  console.log('✅ Authenticated\n');

  console.log('📝 Generating synthetic conversations...\n');

  let successCount = 0;
  let errorCount = 0;

  for (let i = 1; i <= count; i++) {
    const conversation = generateConversation(i);
    const result = await createConversation(api, conversation, dryRun);

    if (result.success) {
      successCount++;
      console.log(`✅ [${i}/${count}] Created: "${conversation.subject.substring(0, 50)}..."`);
    } else {
      errorCount++;
      console.log(`❌ [${i}/${count}] Error: ${result.error?.substring(0, 100)}...`);
    }

    if (!dryRun) {
      await sleep(CONFIG.rateLimitDelay);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Generation Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Created: ${successCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
