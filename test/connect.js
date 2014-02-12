var JanusSession = require('../session');
var test = require('tape');
var session;
var baseUrl = process.env.JANUS_URL || 'http://localhost:8088/janus';

test('create a new session', function(t) {
  t.plan(1);
  session = new JanusSession();
  t.ok(session instanceof JanusSession, 'session instance created');
});

test('attempt connection with server', function(t) {
  t.plan(2);

  // attempt connection
  session.connect(baseUrl, function(err) {
    t.ifError(err);
    t.ok(session.id, 'assigned session id');
  });
});