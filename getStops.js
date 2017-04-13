
var http = require('http');
var xml = require('xml2js');
var async = require('async');
var moment = require('moment');
var schedule = require('node-schedule');
var fs = require('fs');

var sqlite3 = require('sqlite3').verbose();

var nextbusDB = new sqlite3.Database("nextbus");

createDBfromNothing = function(){
  nextbusDB.run("CREATE TABLE IF NOT EXISTS routes (id INT PRIMARY KEY, tag TEXT, title TEXT, color TEXT, latMin REAL, latMax REAL, lonMin REAL, lonMax REAL)");
  nextbusDB.run("CREATE TABLE IF NOT EXISTS stops (id TEXT PRIMARY KEY, tag TEXT, title TEXT, lat REAL, lon REAL)");
  nextbusDB.run("CREATE TABLE IF NOT EXISTS stopsbyroute (routeTag TEXT, stopTag TEXT)");
  nextbusDB.run("CREATE TABLE IF NOT EXISTS predictions (routeTag TEXT, stopTag TEXT, time TEXT, date TEXT, dayOfWeek TEXT, busNum INT, secondsToStop INT, minutesToStop INT, expectedTime TEXT)")

  var options = {
    host: 'webservices.nextbus.com',
    path: "/service/publicXMLFeed?command=routeConfig&a=umd"
  }

  http.request(options, function(response){
    var str = '';
    response.on('data', function(chunk){
      str += chunk;
    })
    response.on('end', function(){
      var stmt = nextbusDB.prepare("INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      xml.parseString(str, function(err, result){

        result.body.route.forEach(function(route){

          stmt.run(parseInt(route.$.tag), route.$.tag, route.$.title, route.$.color, route.$.latMin, route.$.latMax, route.$.lonMin, route.$.lonMax);

        })

        routes = result.body.route.map(function(route){
          return route.$.tag;
        })

        async.parallel(routes.map(function(route){
          return function(callback){
            getAllStops(route, callback);
          };
        }),
         function(err){
          if(err) return next(err);

        });

      })
    })
  }).end();

  getAllStops = function(route, callback){

    options = {
      host: 'webservices.nextbus.com',
      path: "/service/publicXMLFeed?command=routeConfig&a=umd&r=" + route
    };

    http.request(options, function(response){
      var str = '';
      response.on('data', function(chunk){
        str += chunk;
      })
      response.on('end', function(){

        var stopstmt = nextbusDB.prepare("INSERT OR REPLACE INTO stops VALUES (?, ?, ?, ?, ?)");
        var routestmt = nextbusDB.prepare("INSERT OR REPLACE INTO stopsbyroute VALUES (?, ?)");
        var list = []

        xml.parseString(str, function(err, result){
          stops = result.body.route[0].stop.forEach(function(stop){
            stopstmt.run(stop.$.tag, stop.$.tag, stop.$.title, stop.$.lat, stop.$.lon);
            routestmt.run(route, stop.$.tag);
          })

          callback();
        })
      })
    }).end();
  }

}


//createDBfromNothing();

getData = function(buses){

  wherestmt = buses.reduce(function(str, bus, i ){
    if(i == 0){
      return str + " tag = '" + bus + "'";
    } else {
        return str + " OR tag = '" + bus + "'";
    }
  }, '');

  nextbusDB.all("SELECT tag FROM routes WHERE " + wherestmt, function(err, rows){
    rows.forEach(function(row){
      nextbusDB.all("SELECT * FROM stopsbyroute WHERE routeTag = '" + row.tag + "'", function(err, rows){
        stops = rows.reduce(function(str, stop){
          return str + "&stops="  + row.tag + "|" + stop.stopTag;
        }, "")
        trackStop(stops)
      });
    });
  });

  trackStop = function(arg){

    var minutesToStop = 0;
    var pastMinute= 0;
    var pastBus = 0;

    options = {
      host: 'webservices.nextbus.com',
      path: "/service/publicXMLFeed?command=predictionsForMultiStops&a=umd" + arg
    };

    var predictionstmt = nextbusDB.prepare("INSERT OR REPLACE INTO predictions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");

    http.request(options, function(response){
      var str = '';
      response.on('data', function(chunk){
        str += chunk;
      })
      response.on('end', function(){
        xml.parseString(str, function(err, result){
          var d = moment();
          var date = d.format('DD/MM/YYYY');
          var time = d.format('HH:mm');
          var dayOfWeek = d.format('ddd');
          if(!(result.body.predictions[0].direction) || !(result.body.predictions)){
            console.log("Route " + result.body.predictions[0].$.routeTag + " is not running")
            return;
          } else {
            result.body.predictions.map(function(prediction){
              if(Array.isArray(prediction.direction)){
                seconds = prediction.direction[0].prediction[0].$.seconds;
                minutes = prediction.direction[0].prediction[0].$.minutes;
                bus =  prediction.direction[0].prediction[0].$.vehicle;
              } else {
                if( !(prediction.direction)){
                  console.log("Route " + result.body.predictions[0].$.routeTag + " is not running")
                  return;
                }
                seconds = prediction.direction.prediction[0].$.seconds;
                minutes = prediction.direction.prediction[0].$.minutes;
                bus =  prediction.direction.prediction[0].$.vehicle;
              }
              expectedTime = d.add(minutes, 'm').format('HH:mm');
              predictionstmt.run(prediction.$.routeTag, prediction.$.stopTag, time, date, dayOfWeek, bus, seconds, minutes, expectedTime);
              return;
            })
          }

        })
      })
    }).end();
  }
}


var predictionJob = schedule.scheduleJob('*/1 * * * *', function(){

  var hours = moment().get('hour');
  var minutes = moment().get('minute');
  var day = moment().day();
  var buses = [];


  if(day == 2 || day == 4){
    if((hours >= 15)){
      // 140 15-0 TuTh
      buses = buses.concat(['140']);
    }
  }

  if(day == 6 || day == 5 || day == 4){
    if((hours >= 17) || hours <= 5){
      // 131 17-4:30 Th, Fri, sat
      buses = buses.concat(['131']);
    }
  }

  if(day == 6 || day == 0){
    if((hours >= 5) || hours <= 1){
      //104
      buses = buses.concat(['104']);
    }

    if((hours >= 9) || hours <= 4){
      // 115, 116, 117, 118, 122 9:30 - 4
      buses = buses.concat(['115', '116', '117', '118', '122']);
    }
  }

  if(day == 6){
    if((hours >= 10) && hours <= 0){
      // 133 10-23 Sat
      buses = buses.concat(['133']);
    }
  }

  if(day >= 1 && day <= 5){
    if(((hours == 5 && minutes >= 30) || hours >= 6) && hours <= 18){
      // 109 5:30- 18 M-F
      buses = buses.concat(['109']);
    }

    if((hours >= 6)){
      // 111, 126, 143, 141 6:00 - 0 M-F
      buses = buses.concat(['111', '126','143','141']);
    }

    if(((hours == 6 && minutes >= 30) || hours >= 7) && hours <= 23){
      //108, 110, 113, 127 6:30-23 M-F
      buses = buses.concat(['108', '110','113','127']);
    }

    if(((hours == 6 && minutes >= 30) || hours >= 7)){
      // 127 6:30 - 23:30 M-F
      buses = buses.concat(['127']);
    }

    if(((hours == 6 && minutes >= 30) || hours >= 7) && hours <= 18){
      // 105 6:30 - 18 M-F
      buses = buses.concat(['105']);
    }

    if((hours >= 7) && hours <= 18){
      // 114, 132 7-18 M-F
      buses = buses.concat(['114', '132']);
    }

    if((hours >= 7) && hours <= 23){
      // 128 7-23 M-F
      buses = buses.concat(['128']);
    }

    if((hours >= 17) || hours <= 4){
      // 115, 116, 117, 118, 122 17- 4 M-Fri
      buses = buses.concat(['115', '116', '117', '118', '122']);
    }

    if((hours >= 5) || hours <= 1){
      // 104 5:30 - 1 M-Sun
      buses = buses.concat(['104']);
    }

  }

  getData(buses);
  fs.stat("nextbus", function(err, stat){
      console.log(" Updated at " + moment().format("HH:mm") + " File Size is now " + stat.size);
  })
 })
