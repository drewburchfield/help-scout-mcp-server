import { parseRfc822 } from '../utils/rfc822.js';

describe('parseRfc822', () => {
  it('parses a basic message with CRLF line endings', () => {
    const raw = [
      'From: alice@example.com',
      'To: bob@example.com',
      'Subject: hello',
      '',
      'Hi there.',
    ].join('\r\n');

    const result = parseRfc822(raw);

    expect(result.headers['From']).toBe('alice@example.com');
    expect(result.headers['To']).toBe('bob@example.com');
    expect(result.headers['Subject']).toBe('hello');
    expect(result.body).toBe('Hi there.');
  });

  it('handles LF-only line endings', () => {
    const raw = 'Subject: lf-only\n\nbody';
    expect(parseRfc822(raw).headers['Subject']).toBe('lf-only');
    expect(parseRfc822(raw).body).toBe('body');
  });

  it('handles CR-only line endings', () => {
    const raw = 'Subject: cr-only\r\rbody';
    expect(parseRfc822(raw).headers['Subject']).toBe('cr-only');
    expect(parseRfc822(raw).body).toBe('body');
  });

  it('unfolds continuation lines (single space and tab)', () => {
    const raw = [
      'Subject: a very long subject',
      ' that wraps to',
      '\ta third physical line',
      '',
      '',
    ].join('\r\n');

    const result = parseRfc822(raw);
    expect(result.headers['Subject']).toBe('a very long subject that wraps to a third physical line');
  });

  it('collapses repeated headers into an array preserving order', () => {
    const raw = [
      'Received: from a',
      'Received: from b',
      'Received: from c',
      '',
      '',
    ].join('\r\n');

    const result = parseRfc822(raw);
    expect(result.headers['Received']).toEqual(['from a', 'from b', 'from c']);
  });

  it('captures auto-reply headers used by the noise gate', () => {
    const raw = [
      'From: noreply@foo.com',
      'Auto-Submitted: auto-replied',
      'Precedence: bulk',
      'X-Autoreply: yes',
      '',
      '',
    ].join('\r\n');

    const result = parseRfc822(raw);
    expect(result.headers['Auto-Submitted']).toBe('auto-replied');
    expect(result.headers['Precedence']).toBe('bulk');
    expect(result.headers['X-Autoreply']).toBe('yes');
  });

  it('returns an empty body when no separator blank line is present', () => {
    const raw = 'Subject: only-headers';
    const result = parseRfc822(raw);
    expect(result.headers['Subject']).toBe('only-headers');
    expect(result.body).toBe('');
  });

  it('preserves blank lines inside the body', () => {
    const raw = ['Subject: x', '', 'line1', '', 'line2'].join('\r\n');
    const result = parseRfc822(raw);
    expect(result.body).toBe('line1\n\nline2');
  });

  it('skips malformed header lines without a colon', () => {
    // `From bob@example.com ...` is the unix-mbox envelope line and has no colon
    const raw = [
      'From bob@example.com Thu May  8 10:00:00 2026',
      'From: bob@example.com',
      'Subject: hi',
      '',
      'body',
    ].join('\r\n');

    const result = parseRfc822(raw);
    // the envelope line is dropped; the real From: header survives
    expect(result.headers['From']).toBe('bob@example.com');
    expect(result.headers['Subject']).toBe('hi');
  });

  it('preserves header values that contain colons', () => {
    const raw = ['Date: Thu, 8 May 2026 10:00:00 +0000', '', ''].join('\r\n');
    const result = parseRfc822(raw);
    expect(result.headers['Date']).toBe('Thu, 8 May 2026 10:00:00 +0000');
  });
});
