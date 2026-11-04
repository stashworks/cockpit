/* The screen context: what the owner is looking at rides with the message - stored on the turn, rendered in full for the
   new message and as a one-liner on earlier turns. node --test test/screen-context.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { renderPrompt, sizeTranscript } = require('../engine/prompt');
const { openDb } = require('../engine/db');
const conv = require('../engine/conversation');

test('renderPrompt: the screen block precedes the message; earlier turns carry a one-line "looking at"', () => {
  const turns = [{ role: 'user', text: 'what is this', context: 'Cockpit screen: the Problems tab, detail card "fake success"\nProblem: ...' }, { role: 'assistant', text: 'a catch that returns []' }];
  const p = renderPrompt(sizeTranscript(turns, [], null), 'how do I fix these two', 'Cockpit screen: the Problems tab, detail card "fake success", with medium picked\nSelected file: modules/x/datetime.ts');
  assert.ok(p.indexOf('<on_screen>') < p.indexOf('The user now says:'), 'screen block before the message');
  assert.ok(p.includes('Selected file: modules/x/datetime.ts'));
  assert.ok(p.includes('THE USER SAID (looking at: Cockpit screen: the Problems tab, detail card "fake success")'), 'earlier turn says what was on screen, one line');
  assert.ok(!renderPrompt(sizeTranscript([], [], null), 'hi', null).includes('<on_screen>'), 'no block when nothing is on screen');
});

test('the turn stores its context; an older database gets the column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ctx-'));
  const db = openDb(path.join(dir, 'c.db'), path.join(__dirname, '..', 'engine', 'schema.sql'));
  fs.mkdirSync(path.join(dir, '.cockpit', 'conversations'), { recursive: true });   // addTurn mirrors the thread there
  const p = { db, cockpit: { dir: path.join(dir, '.cockpit') } };
  const id = conv.create(p, null);
  conv.addTurn(p, id, 'user', 'what about these', null, null, null, 'the card text');
  conv.addTurn(p, id, 'user', 'and now', null, null, null, null);
  const t = conv.thread(p, id);
  assert.equal(t.turns[0].context, 'the card text'); assert.equal(t.turns[1].context, null);
  const again = openDb(path.join(dir, 'c.db'), path.join(__dirname, '..', 'engine', 'schema.sql'));   // reopening must not fail on the existing column
  assert.equal(again.get('SELECT context FROM chat_turn WHERE id = 1').context, 'the card text');
});
