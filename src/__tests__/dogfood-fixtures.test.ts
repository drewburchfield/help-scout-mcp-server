import { INTEGRATION_CONSTANTS, INTEGRATION_SEED_CONVERSATIONS } from '../../tests/dogfood-fixtures.js';

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
});
