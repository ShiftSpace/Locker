/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

// merge contacts from journals
var fs = require('fs'),
    sys = require('sys'),
    http = require('http'),
    url = require('url'),
    lfs = require('../../Common/node/lfs.js'),
    locker = require("../../Common/node/locker.js"),
    lconfig = require("../../Common/node/lconfig.js"),
    request = require("request"),
    crypto = require('crypto');


var lockerInfo;


var express = require('express'),connect = require('connect');
var app = express.createServer(connect.bodyParser(), connect.cookieParser(), connect.session({secret : "locker"}));

// Process the startup JSON object
process.stdin.resume();
process.stdin.on("data", function(data) {
    lockerInfo = JSON.parse(data);
    if (!lockerInfo || !lockerInfo["workingDirectory"]) {
        process.stderr.write("Was not passed valid startup information."+data+"\n");
        process.exit(1);
    }
    process.chdir(lockerInfo.workingDirectory);
    app.listen(lockerInfo.port, "localhost", function() {
        sys.debug(data);
        process.stdout.write(data);
        gatherContacts();
    });
});

app.set('views', __dirname);

app.get('/', function(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/html'
    });
    lfs.readObjectsFromFile("contacts.json",function(contacts){
        res.write("<html><p>Found "+contacts.length+" contacts: <ul>");
        for(var i in contacts) {
            res.write('<li>' + (contacts[i].name? '<b>' + contacts[i].name + ': </b>' : '') +
                            JSON.stringify(contacts[i])+"</li>");
        }
        res.write("</ul></p></html>");
        res.end();
    });
});

app.get("/allContacts", function(req, res) {
    res.writeHead(200, {
        "Content-Type":"text/javascript"
    });
    res.write("[");
    res.write(fs.readFileSync("contacts.json", "utf8"));
    res.write("]");
    res.end();
});

app.get("/update", function(req, res) {
    gatherContacts();
    res.writeHead(200);
    res.end("Updating");
});

function gatherContacts(){
    // This should really be timered, triggered, something else
    locker.providers(["contact/facebook", "contact/twitter", "contact/google"], function(services) {
        if (!services) return;
        services.forEach(function(svc) {
            if(svc.provides.indexOf("contact/facebook") >= 0) {
                addContactsFromConn(svc.id,'/allContacts','contact/facebook');
            } else if(svc.provides.indexOf("contact/twitter") >= 0) {
                addContactsFromConn(svc.id,'/allContacts','contact/twitter');
            } else if(svc.provides.indexOf("contact/google") >= 0) {
                addContactsFromConn(svc.id, "/allContacts", "contact/google");
            }
        });
    });
}


var contacts = {};
var debug = false;

function cadd(c, type) {
    if(!c)
        return;
        
    morphContact(c, type);
    var key;
    if(c.name)
        key= c.name.replace(/[A-Z]\./g, '').toLowerCase().replace(/\s/g, '');
    else if(c.email && c.email.length > 0)
        key = c.email[0].value;
    else {
        var m = crypto.createHash('sha1');
        m.update(JSON.stringify(c));
        key = m.digest('base64');
    }
    if (contacts[key]) {
        // merge
        mergeContacts(contacts[key], c);
    } else {
        contacts[key] = c;
    }
}

function morphContact(c, type) {
    if(type == 'contact/foursquare')
    {
        if(c.contact.email) c.email = [{'value':c.contact.email}];
        if(c.contact.phone) c.phone = [{'value':c.contact.phone}];
    }
}


/**
 * name
 * email
 * phone
 * address
 * pic (avatar)
 */
function mergeContacts(one, two) {
    mergeArrays(one,two,"_via",function(a,b){return a==b;});
    mergeArrayInObjects(one, two, "email", function(obj1, obj2) {
        return obj1.value.toLowerCase() == obj2.value.toLowerCase();
    });
    mergeArrayInObjects(one, two, "phone", function(obj1, obj2) {
        return obj1.value.replace(/[^0-9]/g,'').toLowerCase() ==
               obj2.value.replace(/[^0-9]/g,'').toLowerCase();
    });
    mergeArrayInObjects(one, two, "address", function(obj1, obj2) {
        return obj1.value.replace(/[,\s!.#-()@]/g,'').toLowerCase() == 
               obj2.value.replace(/[,\s!.#-()@]/g,'').toLowerCase();
    });
    mergeArrayInObjects(one, two, "pic",  function(obj1, obj2) {return false;});
}

/**
 * Merge two arrays of the name arrayName in two objects
 */
function mergeArrayInObjects(obj1, obj2, arrayName, entriesAreEqual) {
    if(obj1[arrayName]) {
        if(obj2[arrayName]) {
            mergeArrays(obj1[arrayName], obj2[arrayName], entriesAreEqual);
        }
    } else if(obj2[arrayName]) {
        obj1[arrayName] = obj2[arrayName];
    }
}

/**
 * Merge two arrays, removing duplicates that match based on equals function
 */
function mergeArrays(one, two, entriesAreEqual) {
    for(var i = 0; i < two.length; i++) {
        var present = false;
        for(var j = 0; j < one.length; j++) {
            if(entriesAreEqual(one[j], two[i]))
                present = true;
        }
        if(!present)
            one.push(two[i]);
    }
}


/**
 * Reads in a file (at path), splits by line, and parses each line as JSON.
 * return parsed objects in an array
 */
function parseLinesOfJSON(data) {
    var objects = [];
    var cs = data.split("\n");
    for (var i = 0; i < cs.length; i++) {
        if (cs[i].substr(0, 1) != "{") continue;
        if(debug) console.log(cs[i]);
        objects.push(JSON.parse(cs[i]));
    }
    return objects;
}

function addContactsFromConn(conn, path, type) {
    var puri = url.parse(lockerInfo.lockerUrl);
    var httpClient = http.createClient(puri.port);
    request.get({url:lconfig.lockerBase + "/Me/"+conn+path}, function(err, res, data) {
        var cs = data[0] == "[" ? JSON.parse(data) : parseLinesOfJSON(data);
        for (var i = 0; i < cs.length; i++) {
            cs[i]["_via"] = [conn];
            cadd(cs[i],type);
        }
        csync();
    });
}

function csync()
{
    var stream = fs.createWriteStream("contacts.json");
    var ccount=0;
    for (var c in contacts) {
        stream.write(JSON.stringify(contacts[c]) + "\n");
        ccount++;
    }
    stream.end();
    console.log("saved " + ccount + " contacts");    
}
