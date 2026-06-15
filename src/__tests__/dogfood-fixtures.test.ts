import {
  INTEGRATION_ACCOUNT_FIXTURES,
  INTEGRATION_CONSTANTS,
  INTEGRATION_SEED_CONVERSATIONS,
} from '../../tests/dogfood-fixtures.js';

describe('dogfood seed fixtures', () => {
  it('defines report-rich conversations assigned to the test user', () => {
    const reportFixtures = INTEGRATION_SEED_CONVERSATIONS.filter((conversation) => conversation.reportFixture);

    expect(reportFixtures.length).toBeGreaterThanOrEqual(3);

    for (const conversation of reportFixtures) {
      expect(conversation.assigneeId).toBe(INTEGRATION_CONSTANTS.userId);
      expect(conversation.status).toBe('closed');
      expect(conversation.threads.some((thread) => thread.type === 'reply')).toBe(true);
    }
  });

  it('defines account-level fixtures for previously skipped dogfood surfaces', () => {
    expect(INTEGRATION_ACCOUNT_FIXTURES.organizationProperty.slug).toMatch(/^mcp-test-/);
    expect(INTEGRATION_ACCOUNT_FIXTURES.organizationProperty.value).toBeTruthy();
    expect(INTEGRATION_ACCOUNT_FIXTURES.savedReply.name).toContain('MCP-TEST');
    expect(INTEGRATION_ACCOUNT_FIXTURES.webhook.label).toContain('MCP-TEST');
    expect(INTEGRATION_ACCOUNT_FIXTURES.webhook.mailboxIds).toEqual([Number(INTEGRATION_CONSTANTS.inboxId)]);
  });

  it('defines a conversation fixture with an uploadable attachment', () => {
    const attachmentFixtures = INTEGRATION_SEED_CONVERSATIONS.filter((conversation) => conversation.attachment);

    expect(attachmentFixtures.length).toBeGreaterThanOrEqual(1);
    expect(attachmentFixtures[0].attachment).toEqual(expect.objectContaining({
      fileName: expect.stringMatching(/^mcp-test-/),
      mimeType: 'text/plain',
      data: expect.any(String),
    }));
  });
});
