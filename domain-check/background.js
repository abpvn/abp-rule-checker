"use strict";
var port, windowId,
    currentDomainData = {},
    pendingDomains = [],
    isOpera = navigator.userAgent.indexOf("OPR/") > -1;

Array.prototype.contains = function(obj) {
  return this.indexOf(obj) !== -1;
};

// Set everything back to their defaults; in case of errors, disconnected ports, closed windows etc., this will deal with it
// Inputs:
//   preparing: [boolean] disables async functions
// Returns:
//   nothing
var reset = function(preparing) {
  console.log("RESET", preparing);
  pendingDomains = [];
  currentDomainData = {};
  try {
    chrome.windows.remove(windowId);
  } catch(ex) {}
  windowId = undefined;
  if (!preparing) {
    chrome.alarms.clearAll();
    chrome.contentSettings.plugins.clear({"scope": "incognito_session_only"});
    chrome.contentSettings.popups.clear({"scope": "incognito_session_only"});
    chrome.contentSettings.notifications.clear({"scope": "incognito_session_only"});
  }
};

// Create a new tab
// Inputs:
//   url: [string] the page URL of the new tab
//   callback: [function] a function to call when the new tab has opened
// Returns:
//   nothing
var createTab = function(url, callback) {
  chrome.tabs.create({
    url: url,
    active: false,
    windowId: windowId,
    pinned: !isOpera
  }, callback);
};

// Create a timer that will close a tab that has become unresponsive in the eyes of the extension
// Inputs:
//   alarmId: [string] a name for the alarm
// Returns:
//   nothing
var handleUnresponsiveTabs = function(alarmId) {
  console.log("alarm created", alarmId);
  chrome.alarms.create(alarmId, {delayInMinutes: 2});
};

// Attempt to close a tab
// Inputs: 
//   tabId: [integer] id of the tab to be closed
//   onSuccess: [function] optional, function to call if the tab was successfully closed
// Returns:
//   nothing
var closeTab = function(tabId, onSuccess) {
  try {
    chrome.tabs.remove(tabId);
    if (onSuccess) {
      onSuccess();
    }
  } catch(ex) {
  }
};

// The result of a check of the subdomains set by attemptCommonResources
// Inputs:
//   details [object] contains information to finalize the check
// Returns:
//   nothing
var subdomainSearchResult = function(details) {
  console.log("subdomainSearchResult:", details);
  var index = currentDomainData.subdomainTabIds.indexOf(details.tabId);
  if (index === -1) {
    return;
  }
  if (/\bOK\b|^HTTP\/\d\.\d\s(?:20\d|4\d\d)\b/i.test(details.statusLine)) {
    finalizeDomainCheck(true);
  } else {
    // TODO: handle redirects here (30x + Location header)
    currentDomainData.subdomainTabIds.splice(index, 1);
    if (currentDomainData.subdomainTabIds.length === 0) {
      finalizeDomainCheck(false, currentDomainData.resultMessage);
    } else {
      closeTab(details.tabId);
    }
  }
};

// The main domain is down. Try a couple of subdomains / resources
// Inputs:
//   message: [string] the error to return to the page in case the subdomains are also dead
// Returns:
//   nothing
var attemptCommonResources = function(message) {
  if (currentDomainData.finished || currentDomainData.resultMessage) {
    return;
  }

  currentDomainData.resultMessage = message;
  console.log("Main URL failed with message:", message, ". Opening tabs with other URLs");

  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(currentDomainData.inputDomain)) {
    finalizeDomainCheck(false, currentDomainData.resultMessage);
  } else {
    chrome.alarms.clear("mainTab", function() {
      console.log("mainTab alarm cleared in attemptCommonResources");
      var i,
          resources = [
            "http://" + currentDomainData.inputDomain + "/robots.txt",
            "http://m." + currentDomainData.inputDomain + "/",
            "http://www." + currentDomainData.inputDomain + "/",
            "http://cdn." + currentDomainData.inputDomain + "/",
            "http://blog." + currentDomainData.inputDomain + "/"
          ];
      handleUnresponsiveTabs("subTabs");
      closeTab(currentDomainData.tabId, function() {
        currentDomainData.tabId = null;
      });
      var createCallBack = function(tab) {
        currentDomainData.subdomainTabIds.push(tab.id);
      };
      for (i=0; i<resources.length; i++) {
        createTab(resources[i], createCallBack);
      }
    });
  }
};

// Initiate the domain check for a new domain
var initiateDomainCheck = function() {
  if (pendingDomains.length === 0) {
    console.log("No domains to check!");
    reset();
    return;
  }

  console.log("STARTING", pendingDomains[0]);
  port.postMessage({domain: pendingDomains[0], started: true});
  createTab("http://" + pendingDomains[0] + "/", function(tab) {
    currentDomainData = {
      inputDomain: pendingDomains[0],
      browserDomain: null, // will be equal to input_domain, except for punycode domains
      tabId: tab.id,
      resultMessage: "",
      subdomainTabIds: [],
      finished: false
    };
    handleUnresponsiveTabs("mainTab");
    chrome.tabs.executeScript(tab.id, {file: "inject.js", runAt: "document_start"});
  });
};

// In case the page has been unresponsive for a predefined time, kill it. Causes for not responding include:
//  - tab never finishes loading
//  - tab is redirected to a malware detected/certificate failure page
chrome.alarms.onAlarm.addListener(function(alarm) {
  console.log("alarm triggered", alarm.name);
  var i;
  switch (alarm.name) {
    case "mainTab": {
      // TODO: in case a 200 (or so) response has been received, assume it's good here...
      attemptCommonResources("Unexpected behaviour: 120 seconds unresponsive");
      break;
    }
    case "subTabs": {
      for (i=currentDomainData.subdomainTabIds.length - 1; i>=0; i--) {
        subdomainSearchResult({statusLine: "unresponsive", tabId: currentDomainData.subdomainTabIds[i]});
      }
      break;
    }
  }
});

// Tell the tab the final results about a certain domain
// Inputs:
//   passed: [boolean] whether the current domain should be kept or failed the tests
//   msgIfFailed: [string] shown in the list of results on the web page
// Returns:
//   nothing
var finalizeDomainCheck = function(passed, msgIfFailed) {
  if (currentDomainData.finished) {
    return;
  }
  console.log("finalizeDomainCheck", passed, msgIfFailed);
  port.postMessage({domain: currentDomainData.inputDomain, passed: passed, msg: msgIfFailed, remaining: pendingDomains.length - 1});
  currentDomainData.finished = true;
  pendingDomains.shift();
  if (pendingDomains.length === 0) {
    console.log("No more pending domains. Disconnecting...");
    port.disconnect();
  }
  chrome.alarms.clearAll(function() {
    chrome.tabs.query({windowId: windowId}, function(tabs) {// windowId might be undefined, if reset was called first...
      console.log("tabs.query in finalizeDomainCheck");
      var i;
      for (i=0; i<tabs.length; i++) {
        if (windowId === tabs[i].windowId && tabs[i].url.substring(0, 5) !== "data:") {
          closeTab(tabs[i].id);
        }
      }
      if (pendingDomains.length > 0) {
        console.log("pending domains:", pendingDomains.length, "next: ", pendingDomains[0]);
        initiateDomainCheck();
      }
    });
  });
};

// Extract the domain from an URL
// Inputs:
//   URL: [string] a page URL
// Returns:
//   [string] a domain, in case it can be extracted
var getOrigin = function(URL) {
  var match = URL.match(/https?\:\/\/([^\/\@\:]+)\//);
  return match && match[1];
};

// Whether the domain of a certain URL equals the currently checked domain
// Inputs:
//   URL: [string] a page URL
// Returns:
//   [boolean] whether the domains are equal
var hasSameOrigin = function(URL) {
  var origin = getOrigin(URL);
  return origin && origin.indexOf(currentDomainData.browserDomain) === origin.length - currentDomainData.browserDomain.length;
};

// Prevent all resources from being loaded, with the exception of main frame URLs
// Check all loaded resources whether they match known parking providers
// Inputs:
//   details: [object] from webRequest.onBeforeRequest
// Returns:
//   webRequest.onBeforeRequest response
var fnOnBeforeRequest = function(details) {
  console.log("onBeforeRequest", details.type, details.url);
  // TODO: collect all domains from which resources were loaded; then give
  // an 'OK' for all domains that were encountered, for which it is also
  // unknown whether it's first or third party. For this, all unknown location
  // resources should be moved to the very end, after the other domains!
  // Only check for sub_frame, image, object, other as they consume space, even
  // if the resource is offline.
  if (details.type === "main_frame") {
    if (!currentDomainData.browserDomain) {
      currentDomainData.browserDomain = getOrigin(details.url);
    } else if (!hasSameOrigin(details.url)) {
      return {cancel: true};
    }
    return {cancel: false};
  }

  var i, parked = [
    /pagead2\.googlesyndication\.com\/apps\/domainpark\/show_afd_ads\.js/,
    /googleads\.g\.doubleclick\.net\/apps\/domainpark\/domainpark\.cgi\?/,
    /\/registrar\/dopark\.js/,
    /domainnamesales\.com\/return_js\.php\?/,
    /google\.com\/adsense\/domains\/caf\.js/,
    /sedoparking\.com\//,
    /domainmarket\.com\//,
    /cdn\-image\.com\//,
    /\&prvtof\=.+\&poru\=/
  ];
  if (currentDomainData.tabId === details.tabId) {
    for (i=0; i<parked.length; i++) {
      if (parked[i].test(details.url)) {
        console.log("PARKED DETECTED:", details.url);
        finalizeDomainCheck(false, "PARKED");
        break;
      }
    }
  }

  return {cancel: true};
};

// In case a password is needed, something must be live. Assume it's live.
// Inputs:
//   details: [object] from webRequest.onAuthRequired
// Returns:
//   nothing
var fnOnAuthRequired = function(details) {
  console.log("onAuthRequired", details.url);
  if (currentDomainData.tabId === details.tabId) {
    finalizeDomainCheck(true);
  }
};

// In case of a perminent redirect, check whether it is a subdomain. If so, allow it, otherwise report a redirect
// In case of a temporary redirect, check whether it is a parked domain. If so, report parked, otherwise allow it
// Inputs:
//   details: [object] from webRequest.onBeforeRedirect
// Returns:
//   nothing
var fnOnBeforeRedirect = function(details) {
  console.log("onBeforeRedirect", details.url, details.redirectUrl, details.statusCode);
  if (currentDomainData.tabId !== details.tabId) {
    return;
  }
  if ([301, 308].contains(details.statusCode)) {
    if (!hasSameOrigin(details.redirectUrl)) {
      attemptCommonResources("REDIRECT to " + getOrigin(details.redirectUrl));
    }
  } else {
    var i, parked = [
      new RegExp("\\:\\/\\/ww1\\." + getOrigin(details.redirectUrl) + "\\/\\?pid\\=")
    ];
    for (i=0; i<parked.length; i++) {
      if (parked[i].test(details.redirectUrl)) {
        console.log("PARKED DETECTED:", details.redirectUrl);
        finalizeDomainCheck(false, "PARKED");
        break;
      }
    }
    if (!hasSameOrigin(details.redirectUrl)) {
      finalizeDomainCheck(true); // allow temporary redirects
    }
  }
};

// In case an error occurs, the page must be down. Report this.
// Inputs:
//   details: [object] from webRequest.onErrorOccurred
// Returns:
//   nothing
var fnOnErrorOccurred = function(details) {
  console.log("onErrorOccurred", details.url);
  if (currentDomainData.tabId === details.tabId) {
    attemptCommonResources(details.error);
  } else if (currentDomainData.subdomainTabIds && currentDomainData.subdomainTabIds.contains(details.tabId)) {
    subdomainSearchResult(details);
  }
};

// In case a page completes it's loading, it must be online (if no other return condition triggered)
// Report the domain as being online
chrome.webNavigation.onCompleted.addListener(function(details) {
  if (currentDomainData.tabId === details.tabId && details.frameId === 0) {
    console.log("onCompleted", details.url);
    finalizeDomainCheck(true);
  }
});

// In case of a client redirect (via JavaScript or meta tags), treat this as a non-perminent redirect
chrome.webNavigation.onCommitted.addListener(function(details) {
  if (details.transitionQualifiers.contains("client_redirect")) {
    console.log("onCommitted", "client_redirect");
    details.statusCode = 307;
    details.redirectUrl = details.url;
    details.url = "http://" + currentDomainData.browserDomain + "/";
    fnOnBeforeRedirect(details);
  }
});

// Make sure we never load content types that will trigger downloads
// Also, in case of the check for live subdomains, only check the status code. Do not wait for the full page to load
// Inputs:
//   details: [object] from webRequest.onHeadersReceived
// Returns:
//   webRequest.onHeadersReceived response
var fnOnHeadersReceived = function(details) {
  console.log("onHeadersReceived", details.url);
  var i;

  if (currentDomainData.tabId === details.tabId) {
    for (i=0; i<details.responseHeaders.length; i++) {
      switch (details.responseHeaders[i].name) {
        case "Content-Type": {
          if (!details.responseHeaders[i].value || !/^text\/|^application\/(\w+\+)?(xml|json)$/.test(details.responseHeaders[i].value)) {
            console.log("Content-Type", details.responseHeaders[i].value);
            finalizeDomainCheck(true);
            return {cancel: true};
          }
          break;
        }
        case "Content-Disposition": {
          if (details.responseHeaders[i].value && /attachment/i.test(details.responseHeaders[i].value)) {
            console.log("Content-Disposition", details.responseHeaders[i].value);
            finalizeDomainCheck(true);
            return {cancel: true};
          }
          break;
        }
      }
    }
    return {cancel: false};
  }
  subdomainSearchResult(details);
  return {cancel: true};
};

// Handle the communication originating from the tab
chrome.runtime.onConnectExternal.addListener(function(p) {
  port = p;
  port.onMessage.addListener(function(msg) {
    console.log("onMessage", msg);
    if (msg.domains) {
      pendingDomains = msg.domains;
      if (windowId) {
        // we finished a certain depth of subdomains; proceed with the next series
        initiateDomainCheck();
      } else {
        // create a new window; register all listeners; set some settings... and start
        chrome.windows.create({
          // for some reason, chrome-extension:// URLs are forbidden in incognito. Use a data: url instead...
          url: ["data:text/html,<!DOCTYPE html>" + "<html lang=\"en\">" + "<head>" + "<meta charset=\"UTF-8\">" +
                "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'\" />" +
                "<title>Redundancy check: Domain check</title>" + "</head>" + "<body>" + "<h3>Domain checker window</h3>" +
                "<p>Close this window to cancel the domain check! Please note:</p>" + "<ul>" +
                "<li>this extension needs access to incognito pages in order to function correctly!</li>" +
                "<li>this extension MAY have issues with other resource blocking extensions. Temporarily disable such extensions (including adblockers) while it is running! Do NOT disable your antivirus!</li>" +
                "<li>this extension disables all plugins on all incognito websites, until all windows currently opened have been closed</li>" +
                "<li>this specific window should not be used for browsing as all tabs are closed automatically, even the ones you opened manually</li>" +
                "<li>this may take a while... don't stare at this window all the time, go play games, use another browser, visit some friends, catch up with your missing sleep, etcetera!</li>" +
                "</ul>" + "</body>" + "</html>"],
          focused: false,
          incognito: true
        }, function(window) {
          console.log("window opened");
          windowId = window.id;
          var firstTabId = window.tabs[0].id;
          chrome.tabs.update(firstTabId, {pinned: true});
          chrome.tabs.onRemoved.addListener(function(tabId) {
            if (windowId && tabId === firstTabId) {
              console.log("first tab removed: cancelling");
              reset();
              port.postMessage({cancelled: true});
            }
          });
          chrome.webRequest.onBeforeRequest.addListener(fnOnBeforeRequest, {urls: ["<all_urls>"], windowId: windowId}, ["blocking"]);
          chrome.webRequest.onAuthRequired.addListener(fnOnAuthRequired, {urls: ["<all_urls>"], types: ["main_frame"], windowId: windowId});
          chrome.webRequest.onBeforeRedirect.addListener(fnOnBeforeRedirect, {urls: ["<all_urls>"], types: ["main_frame"], windowId: windowId});
          chrome.webRequest.onErrorOccurred.addListener(fnOnErrorOccurred, {urls: ["<all_urls>"], types: ["main_frame"], windowId: windowId});
          chrome.webRequest.onHeadersReceived.addListener(fnOnHeadersReceived, {urls: ["<all_urls>"], types: ["main_frame"], windowId: windowId}, ["blocking", "responseHeaders"]);
          var contentSettingsOptions = {
            "primaryPattern": "<all_urls>",
            "setting": "block",
            "scope": "incognito_session_only"
          };
          chrome.contentSettings.plugins.set(contentSettingsOptions, function() {
            chrome.contentSettings.popups.set(contentSettingsOptions, function() {
              chrome.contentSettings.notifications.set(contentSettingsOptions, function() {
                console.log("check started");
                initiateDomainCheck();
              });
            });
          });
        });
      }
    } else if (msg.done) {
      // No more domains; reset everything
      reset();
    } else if (msg.prepare) {
      // Tell the page we are installed and if we have access to incognito pages
      reset(true);
      chrome.extension.isAllowedIncognitoAccess(function(isAllowedIncognitoAccess) {
        port.postMessage({installed: true, incognito: isAllowedIncognitoAccess});
      });
    }
  });
  port.onDisconnect.addListener(function() {
    console.log("onDisconnect");
    reset();
  });
});
