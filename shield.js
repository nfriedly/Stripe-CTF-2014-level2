#!/usr/bin/env node

"use strict";

var http = require('http');
var httpProxy = require('./network_simulation/lib/proxy');
var checkServer = require('./network_simulation/lib/check_server');
var nopt = require('nopt');
var url = require('url');
var _ = require('underscore');

var RequestData = function (request, response, buffer) {
  this.request = request;
  this.response = response;
  this.buffer = buffer;
};

function ipFromRequest(reqData) {
  return reqData.request.headers['x-forwarded-for'];
}

function rejectRequest(reqData) {
  reqData.response.writeHead(400);
  reqData.response.end();
}

var Queue = function (proxies, parameters) {
  this.proxies = proxies;
  this.parameters = parameters;
};
Queue.prototype.takeRequest = function (reqData) {
  // Reject traffic as necessary:
  if (currently_blacklisted(ipFromRequest(reqData))) {
    rejectRequest(reqData);
    return;
  }
  // Otherwise proxy it through:
  var which = Math.floor(Math.random() * this.proxies.length);
  this.proxies[which].proxyRequest(reqData.request, reqData.response, reqData.buffer);
};
Queue.prototype.requestFinished = function () {
  return;
};

// map of IP => number of requests received from that IP
var hits = {};
function currently_blacklisted(ip) {
    hits[ip] = hits[ip] || 0;
    hits[ip]++;
    return (hits[ip] > 2);
}

// 10 times per second, decrease the hit count of some of the ips. 
// Chances of a decrease are higher if the IP has fewer hits already.
function decrementHits(){
    hits = _.map(hits, function(hits) {
        if (!hits) return 0;
        if (Math.random() > (1/hits) ) {
            return hits-1;
        } else {
            return hits;
        }
    });
}
setInterval(decrementHits, 200);

function checkBackends(targets, path, response) {
  var toCheck = targets.map(function (target) {
    var output = {};
    output['host'] = target['host'];
    output['port'] = target['port'];
    output['path'] = path;
    return output;
  });
  var success = function () {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end()
  };
  var error = function () {
    response.writeHead(500, {"Content-Type": "application/json"});
    response.end()
  };
  checkServer.checkServers(toCheck, success, error);
}

function main() {
  var opts = {
    "out-ports": String,
    "in-port": String,
  };
  var parsed = nopt(opts),
      inPort = parsed['in-port'] || '3000',
      outPorts = parsed['out-ports'] ? parsed['out-ports'].split(",") : ['3001'],
      targets = [],
      target,
      proxies = [],
      proxy,
      i;

  for (i = 0; i < outPorts.length; i++) {
    target = {'host': 'localhost', 'port': outPorts[i]};
    targets.push(target);
    proxy = new httpProxy.HttpProxy({'target': target});
    proxy.identifier = i;
    proxies.push(proxy);
  }

  var queue = new Queue(proxies, {});
  for (i = 0; i < proxies.length; i++) {
    proxy = proxies[i];
    proxy.on("end", queue.requestFinished);
  }

  var server = http.createServer(function (req, res) {
    if (req.method === "HEAD") {
      // HEAD requests are used to monitor the status of the simulation
      // proxies[0].proxyRequest(reqData.request, reqData.response, reqData.buffer);
      checkBackends(targets, url.parse(req.url)['pathname'], res);
    } else {
      var buffer = httpProxy.buffer(req);
      var reqData = new RequestData(req, res, buffer);
      queue.takeRequest(reqData);
    }
  });

  server.on('close', function () {
    for (i = 0; i < proxies.length; i++) {
      proxies[i].close();
    }
  });
  console.log("The shield is up and listening.");
  server.listen(inPort);
}

main();
