var fns = ["alert", "confirm", "prompt", "open", "eval", "addEventListener"];
var scr = document.createElement("script");
scr.type = "text/javascript";
scr.textContent = "window." + fns.join(" = function() {}; window.") + " = function() {};" +
                  "Object.defineProperty(window, 'onbeforeunload', {value: null});";

(document.head || document.documentElement).insertBefore(scr, null);
scr.parentNode.removeChild(scr);

// note: will fail if CSP prevents inline scripts. However, we already block their scripts in such cases :)