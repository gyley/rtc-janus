/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var request = require('hyperquest');
var uuid = require('uuid');
var extend = require('cog/extend');
var jsonparse = require('cog/jsonparse');
var reTrailingSlash = /\/$/;

/**
  ### JanusSession

  Create a new JanusSession instance
**/
function JanusSession(opts) {
  if (! (this instanceof JanusSession)) {
    return new JanusSession(opts);
  }

  EventEmitter.call(this);

  // initilaise the poll interval
  this.pollInterval = (opts || {}).pollInterval || 500;

  // initialise the id to null as this is generated by the server
  this.id = null;

  // set the uri to null
  this.uri = null;

  // initialise the plugins hash which will store plugin handle ids
  this.plugins = {};

  // initialise a poll request object
  this.pollRequest = null;
}

util.inherits(JanusSession, EventEmitter);
module.exports = JanusSession;

var proto = JanusSession.prototype;

/**
  #### activate(namespace, callback)

  Activate the specified plugin.  A plugin can be specified by it's full
  namespace (e.g. `janus.plugin.streaming`) or if it is a standard janus
  plugin through just it's id (e.g. `streaming`).

**/
proto.activate = function(namespace, callback) {
  var parts = namespace.split('.');
  var session = this;
  var pluginName;

  // if we have not been provided, dot delimited plugin name then
  // prepend janus.plugin to the pluginName
  if (parts.length === 1) {
    namespace = 'janus.plugin.' + namespace;
    parts = namespace.split('.');
  }

  // get the plugin name (last part of the namespace)
  pluginName = parts[parts.length - 1];

  this._command('attach', { plugin: namespace }, function(err, data) {
    var id = data && data.id;

    if (err) {
      return callback(err);
    }

    // update the plugin handles to include this handle
    session.plugins[pluginName] = id;

    // patch in the plugin method
    session[pluginName] = proto._message.bind(session, id);

    // fire the callback
    callback(null, id);
  });
};

/**
  #### connect(uri, callback)

  Create a new connection to the janus gateway
**/
proto.connect = function(uri, callback) {
  var session = this;
  var transaction = uuid.v4();

  // update the url
  this.uri = uri.replace(reTrailingSlash, '');

  this._command('create', function(err, data) {
    if (err) {
      return callback(err);
    }

    session.id = data && data.id;

    // start polling for response messages
    session._poll();

    // trigger the callback
    callback();
  });
};

/**
  #### disconnect(callback)

  Disconnect from the gateway
**/
proto.disconnect = function(callback) {
  var session = this;

  // send the destroy command
  return this._command('destroy', function(err) {
    if (err) {
      return callback(err);
    }

    if (session.pollRequest) {
      session.pollRequest.end();
    }

    // clear the session id and trigger the callback
    session.id = null;
    callback();
  });
};

proto._command = function(command, payload, callback) {
  if (typeof payload == 'function') {
    callback = payload;
    payload = {};
  }

  return this._post(extend({}, payload, {
    janus: command
  }), callback);
};

proto._message = function(id, body, callback) {
  var payload;
  var session = this;
  var transactionId;
  var jsep;
  var dupBody = {};

  if (typeof body == 'function') {
    callback = body;
    body = {};
  }

  Object.keys(body).forEach(function(key) {
    if (key === 'jsep') {
      jsep = body[key];
    }
    else {
      dupBody[key] = body[key];
    }
  });

  // initialise the payload
  payload = {
    body: dupBody,
    janus: 'message',
    jsep: jsep
  };

  transactionId = this._post(payload, { path: id, ok: 'ack' }, function(err) {
    if (err) {
      return callback(err);
    }

    session.once('event:' + transactionId, function(pluginData, body) {
      callback(null, pluginData, body);
    });
  });

  console.log('sent transaction: ' + transactionId);
};

proto._poll =function() {
  var req;
  var session = this;
  var chunks = [];

  // if we have no session id then abort
  if (! this.id) {
    return;
  }

  // create the request
  req = this.pollRequest = request.get(this.uri + '/' + this.id + '?rid=' + Date.now());
  req.on('response', function(res) {
    var ok = res && res.statusCode === 200;

    if (! ok) {
      // TODO: more error details
      return callback(new Error('request failed: ' + res.statusCode));
    }

    res.on('data', function(data) {
      chunks.push(data.toString());
    });

    res.on('end', function() {
      var body = body = jsonparse(chunks.join(''));
      var eventName = body && body.janus;
      var data;

      if (body && body.transaction) {
        switch (body.janus) {
          case 'event': {
            data = body.plugindata;

            // extract the embedded data object if it exists
            if (data.data) {
              data = data.data;
            }

            // if we've got embedded result data, then extract that also
            if (data.result) {
              data = data.result;
            }

            eventName = body.janus + ':' + body.transaction;
            break;
          }
        }

        if (data) {
          // if we have jsep as part of the body request
          // patch that into the data
          data.jsep = body.jsep;
        }

        session.emit(eventName, data, body);
      }

      // // check for success
      // if (body.janus !== okResponse) {
      //   return callback(new Error('request failed: ' + body.janus));
      // }

      // // check the transaction is a match
      // if (body.transaction !== payload.transaction) {
      //   return callback(new Error('request mismatch from janus'));
      // }

      // callback(null, body.data);;

      // poll again
      session._poll();
    });
  });

  // intercept errors
  // TODO: determine correct handling approach
  req.on('error', function(err) {
  });
};

proto._post = function(payload, opts, callback) {
  var req;
  var chunks = [];
  var uri = this.uri;
  var okResponse = 'success';
  var transactionId = uuid.v4();

  if (typeof opts == 'function') {
    callback = opts;
    opts = {};
  }

  // if we have been provided a custom ok message, then use that instead
  if (opts.ok) {
    okResponse = opts.ok;
  }

  // if we have a valid session id then route the request to that session
  if (this.id) {
    uri += '/' + this.id + (opts && opts.path ? '/' + opts.path : '');
  }

  // create the request
  req = request.post(uri);

  // attach a transaction to the payload
  payload = extend({ transaction: transactionId }, payload);

  req.setHeader('Content-Type', 'application/json');
  req.write(JSON.stringify(payload));

  req.on('response', function(res) {
    var ok = res && res.statusCode === 200;

    res.on('data', function(data) {
      chunks.push(data.toString());
    });

    res.on('end', function() {
      var body;

      if (! ok) {
        // TODO: more error details
        return callback(new Error('request failed: ' + res.statusCode));
      }

      // parse the response body
      body = jsonparse(chunks.join(''));

      // check for success
      if (body.janus !== okResponse) {
        return callback(new Error('request failed: ' + body.janus));
      }

      // check the transaction is a match
      if (body.transaction !== payload.transaction) {
        return callback(new Error('request mismatch from janus'));
      }

      callback(null, body.data);;
    });
  });

  req.on('error', callback);
  req.end();

  // return the transaction id
  return transactionId;
};