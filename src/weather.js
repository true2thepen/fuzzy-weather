'use strict';

let debug = require('debug')('fuzzy-weather'),
    debugCurrently = require('debug')('fuzzy-weather:currently'),
    debugHourly = require('debug')('fuzzy-weather:hourly'),
    debugDaily = require('debug')('fuzzy-weather:daily'),
    _ = require('lodash'),
    request = require('request'),
    moment = require('moment-timezone'),
    tempModule = require('./conditions/temp');
require('./array-util');

const OPTIONS = {
    apiKey: null,
    location: { lat: null, lng: null },
    avgTemps: [            // averages for Washington, DC
        {high:40, low:30}, // Jan
        {high:45, low:30}, // Feb
        {high:55, low:40}, // Mar
        {high:65, low:45}, // Apr
        {high:75, low:55}, // May
        {high:85, low:65}, // Jun
        {high:90, low:70}, // Jul
        {high:85, low:70}, // Aug
        {high:80, low:65}, // Sep
        {high:70, low:50}, // Oct
        {high:60, low:40}, // Nov
        {high:45, low:35}  // Dec
    ],
    dewPointBreak: 69,
    humidityBreak: 0.70,
    windBreak: 15,
    cloudBreak: 0.65
};

module.exports = function(options = {}) {
    let o = {};
    _.merge(o, OPTIONS, options);
    debug('Setting up new fuzzy-weather with options:', o);
    return getWeatherForDate;

    /**
     * The publicly available function for getting weather for a given date.
     *
     * @param  {String|Number} requestedDate Anything that can be passed into new Date() (OPTIONAL, will use current date otherwise)
     * @return {Promise}                     Will resolve (hopefully) with an object containing the weather report:
     *                                         {
     *                                           date: Date,
     *                                           currently: Object,    // will be `null` if date is not current day
     *                                           dailySummary: Object,
     *                                           detail: Object        // will be `null` if the date is not within 48 hours
     *                                         }
     *                                       Note that the Object for each section above will always contain:
     *                                         {
     *                                           data: Object,       // Direct from the Dark Sky API
     *                                           conditions: Object, // key / readable text (i.e. "heat": "it'll be scorcher tomorrow")
     *                                                               // These "conditions" will only be present when necessary (like it's really hot)
     *                                           forecast: String    // suitable for voice output
     *                                         }
     *                                       May also reject with an {Error}
     */
    function getWeatherForDate(requestedDate) {
        return new Promise(function (resolve, reject) {
            debug('Getting weather for %s', requestedDate);

            if (!o.apiKey) {
                debug('API key?', o.apiKey);
                return reject(new Error('No API key for Dark Sky provided'));
            }

            if (!o.location || !o.location.lat || !o.location.lng ||
                typeof(o.location.lat) !== 'number' || typeof(o.location.lng) !== 'number') {
                debug('lat/lng?', o.location.lat, o.location.lng);
                return reject(new Error('Lattitude and longitude must be provided and be numeric'));
            }

            let now = new Date();
            let todaySimple = moment(now).format('YYYY-MM-DD');

            // No date? no problem! Just get today's weather.
            if (!requestedDate) {
                requestedDate = now.getTime();
            }

            let reqDateObj = new Date(requestedDate);
            if (!reqDateObj.getTime()) {
                return reject(new Error('Please provide a valid date to check the weather for!'));
            }
            reqDateObj.setHours(0);
            let simpleDate = moment(reqDateObj).format('YYYY-MM-DD');

            if (simpleDate < todaySimple) {
                return reject(new Error(`Unable to get weather foreacast for date in the past (${simpleDate})`));
            } else if (reqDateObj.getTime() > (now.getTime() + (86400000 * 7))) {
                return reject(new Error(`Only able to get weather for dates within 7 days of now (${simpleDate})`));
            }

            request({
                url: `https://api.darksky.net/forecast/${o.apiKey}/${o.location.lat},${o.location.lng}`
            }, function(err, res, body) {
                if (err) {
                    debug('Error from API call', err);
                    if (!(err instanceof Error)) {
                        err = new Error(''+err);
                    }
                    return reject(err);
                } else if (res.statusCode > 299) {
                    debug('Non-200 status code from weather API:', res.statusCode, body);
                    return reject(
                        new Error(`There was a problem getting weather data: received non-200 status code (${res.statusCode})`)
                    );
                }

                let data;
                try {
                    data = JSON.parse(body);
                } catch(e) {
                    debug('Invalid JSON data from weather API:', body);
                    return reject(new Error('The API did not return valid data.'));
                }

                resolve({
                    currently: getCurrentConditions(o, data, reqDateObj),
                    dailySummary: getDailySummary(o, data, reqDateObj),
                    detail: getDetail(o, data, reqDateObj),
                    date: reqDateObj
                });
            });
        });
    }
};

/**
* Build the text for the daily summary weather report for the given date
*
* @param  {Object} o      The options for this instance of fuzzy weather
* @param  {Object} data   The data returned from the Dark Sky API
* @param  {Date} reqDate  The date of the request
* @return {Object}        The daily summary text of the forecast { data, conditions, forecast }
 */
function getDailySummary(o, data, reqDate) {
    let simpleDate = moment(reqDate).format('YYYY-MM-DD');
    let info = {
        data: null,
        conditions: {},
        forecast: null
    };

    debugDaily(`getting daily summary for ${simpleDate}`);

    data.daily.data.forEach(function(dailyData) {
        if (moment(dailyData.time * 1000).format('YYYY-MM-DD') === simpleDate) {
            dailyData.type = 'daily';
            let day = getDayOfWeek(reqDate, true);

            info.data = dailyData;
            let text = getDailyConditions(o, dailyData)
                .map(function(condition, i) {
                    let conditionMod,
                        condText,
                        text = [];

                    debugDaily('getting text for condition:', condition);

                    try {
                        conditionMod = require('./conditions/' + condition.topic);
                    } catch(err) {
                        debugDaily('No condition module for %s', condition.topic);
                    }

                    if (!conditionMod) { return ''; }

                    if (i === 0) {
                        text.push(render(conditionMod.headline(), {
                            day: day
                        }));
                    }
                    condText = conditionMod.dailyText(condition, dailyData, data.timezone);
                    info.conditions[condition.topic] = condText;
                    text.push(render(condText, {
                        day: day
                    }));
                    return text.join(' ');
                })
                .filter(function(piece) { return piece.trim().length; });

            let hour = moment(dailyData.time * 1000).format('h');
            if (!text.length && day === 'today' && hour > 10) {
                text.push('The rest of today will be pretty quiet weather wise,');
            } else if (!text.length) {
                text.push(render(`{day} will be pretty quiet weather wise,`, { day }));
            }


            let refinedData = getHourByHourData(data, reqDate);
            text.push(render(tempModule.summary(data.timezone, dailyData, (refinedData && refinedData.hourly)), {
                day: day
            }));

            info.forecast = text.join(' ').replace(/\n/g, ' ');
        }
    });

    return info;
}


/**
 * Build the text for the hour-by-hour (ish) weather report for the given date
 *
 * @param  {Object} o      The options for this instance of fuzzy weather
 * @param  {Object} data   The data returned from the Dark Sky API
 * @param  {Date} reqDate  The date of the request
 * @return {Object|null}   The hour-by-hour text of the forecast (null if not today or tomorrow)  { data, conditions, forecast }
 */
function getDetail(o, data, reqDate) {
    let info = {
        data: null,
        conditions: {},
        forecast: null
    };

    let refinedData = getHourByHourData(data, reqDate);
    if (!refinedData) { return null; }
    info.data = refinedData.hourly;

    let simpleDate = moment(reqDate).format('YYYY-MM-DD');
    debugHourly(`getting hour-by-hour summary for ${simpleDate}`);

    let text = [];
    let conditions = getDailyConditions(o, refinedData.daily);

    // TODO: need to add full temperature data/text to the forecast in all cases where possible

    let dailyData = {};
    data.daily.data.forEach(function(singleDayData) {
        if (moment(singleDayData.time * 1000).format('YYYY-MM-DD') === simpleDate) {
            dailyData = singleDayData
            singleDayData.type = 'daily';
        }
    });

    text.push(tempModule.summary(data.timezone, dailyData, refinedData.hourly));

    conditions.forEach(function getHourlyText(condition) {
        try {
            debugHourly('loading condition module for %s', condition.topic);
            let conditionMod = require('./conditions/' + condition.topic);
            text.push(conditionMod.hourlyText(refinedData.hourly, data.timezone, dailyData));
            info.conditions[condition.topic] = conditionMod.dailyText(condition, dailyData, data.timezone);

        } catch(err) {
            debugHourly('Cannot get conditions from module for %s:', condition.topic, err.message);
        }
    });

    info.forecast = render(text.join(' ').replace(/\n/g, ' '), {
        day: getDayOfWeek(reqDate, true)
    });

    return info;
}


function getHourByHourData(data, reqDate) {
    let refinedData = null;
    let now = new Date();
    let simpleDate = moment(reqDate).format('YYYY-MM-DD');
    let todaySimple = moment(now).format('YYYY-MM-DD');
    let tomorrowSimple = moment(now).add(1, 'd').format('YYYY-MM-DD');

    if (todaySimple === simpleDate || tomorrowSimple === simpleDate) {
        let hourStart = 0;
        let hourEnd = 0;
        let dailyIndex = 0;

        // determine what data applies to the requested day
        if (todaySimple === simpleDate) {
            for (let i=0; i<24; ++i) {
                if (moment(data.hourly.data[i].time * 1000).format('YYYY-MM-DD') !== simpleDate) {
                    hourEnd = i;
                    break;
                }
            }
        } else {
            // If it isn't today, it's tomorrow
            dailyIndex = 1;
            for (let i=0; i<49; ++i) {
                if (!hourStart && moment(data.hourly.data[i].time * 1000).format('YYYY-MM-DD') === simpleDate) {
                    hourStart = i;
                } else if (hourStart && moment(data.hourly.data[i].time * 1000).format('YYYY-MM-DD') !== simpleDate) {
                    hourEnd = i;
                    break;
                }
            }
            hourEnd = hourEnd || 49;
        }

        refinedData = {
            hourly: data.hourly.data.slice(hourStart, hourEnd),
            daily: data.daily.data[dailyIndex]
        };
    }

    return refinedData;
}

/**
* Build the text for the current conditions (today / right now)
*
* @param  {Object} o      The options for this instance of fuzzy weather
* @param  {Object} data   The data returned from the Dark Sky API
* @param  {Date} reqDate  The date of the request
* @return {Object|null}   The current condition text of the forecast (or null if not for today) { data, conditions, forecast }
 */
function getCurrentConditions(o, data, reqDate) {
    let simpleDate = moment(reqDate).format('YYYY-MM-DD');
    let todaySimple = moment(Date.now()).format('YYYY-MM-DD');
    let avgTemps = o.avgTemps[(new Date(data.currently.time * 1000)).getMonth()];

    let text = [];
    let info = {
        data: data.currently,
        conditions: {},
        forecast: null
    };

    if (simpleDate !== todaySimple) { return null; }

    debugCurrently(`getting current conditions for ${simpleDate}`);

    if (data.currently.precipProbability > 0.8) {
        let intensityText = '';
        if (data.currently.precipIntensity > 0.7) {
            intensityText = 'extremely heavy';
        } else if (data.currently.precipIntensity > 0.2) {
            intensityText = 'heavy';
        } else if (data.currently.precipIntensity > 0.07) {
            intensityText = 'moderate';
        } else if (data.currently.precipIntensity > 0.01) {
            intensityText = 'light';
        } else {
            if (data.currently.precipType === 'snow') {
                intensityText = 'very light';
            } else {
                intensityText = 'drizzling';
            }
        }
        let precipText = `There is ${intensityText} ${data.currently.precipType} right now`;
        text.push(precipText);
        info.conditions[data.currently.precipType] = precipText;
    } else {
        if (data.currently.cloudCover < 0.4) {
            text.push(`It's ${(data.currently.cloudCover > 0.1) ? 'mostly' : ''} sunny right now`);
        } else if (data.currently.cloudCover < o.cloudBreak) {
            text.push(`There are some clouds right now`);
        } else {
            let cloudText = `It's cloudy right now`;
            text.push(cloudText);
            info.conditions.clouds = cloudText;
        }
    }

    let temp = `and it's currently ${Math.round(data.currently.temperature)} degrees`;
    if (data.currently.apparentTemperature > (data.currently.temperature + 5) ||
        data.currently.apparentTemperature < (data.currently.temperature - 5)) {
        temp += `, but it feels like ${Math.round(data.currently.apparentTemperature)}`;
    }
    text.push(temp + '.');

    if (data.currently.temperature > avgTemps.high || data.currently.apparentTemperature > (avgTemps.high + 5)) {
        info.conditions.heat = temp;
    } else if (data.currently.temperature < avgTemps.low || data.currently.apparentTemperature < (avgTemps.low - 5)) {
        info.conditions.cold = temp;
    }

    if (data.currently.dewPoint >= o.dewPointBreak && data.currently.humidity >= o.humidityBreak) {
        let humidText = `It'll feel sticky as well with ${Math.round(data.currently.humidity * 100)} percent humidity.`;
        text.push(humidText);
        info.conditions.humidity = humidText;
    }

    if (data.currently.windSpeed > o.windBreak) {
        let windText = `And the wind is up around ${Math.round(data.currently.windSpeed)} miles per hour.`;
        text.push(windText);
        info.conditions.wind = windText;
    }

    if (data.alerts && data.alerts.length) {
        let alerts = [];
        let types = [];
        data.alerts.forEach(function checkAlertTime(alert) {
            if (data.currently.time > alert.time && data.currently.time < alert.expires) {
                if (types.includes(alert.title)) { return; }
                types.push(alert.title);
                let expires = moment.tz(alert.expires * 1000, 'GMT').tz(data.timezone);

                if (alert.title.toLowerCase() === 'special weather statement') {
                    let description = alert.description.substr(0, alert.description.indexOf('For additional info'));
                    alerts.push(`until ${expires.format('ha')}: ${description}`);
                } else {
                    alerts.push(`${alert.title} until ${expires.format('ha')}`);
                }
            }
        });
        if (alerts.length > 1) {
            text.push('There are multiple weather alerts:');
        } else if (alerts.length) {
            text.push('There is a weather alert:');
        }
        text = text.concat(alerts);
    }

    info.forecast = text.join(' ').replace(/\n/g, ' ');
    debugCurrently(info.forecast);
    return info;
}

/**
 * This method takes some daily foreacast data and determines what conditions
 * exist that we want to report on. For example, if there is no wind expected
 * today then we don't need to say that. The data returned is an array of the
 * conditions that *should* be reported on, sorted by severity - `level` in
 * the data. Also included is a text `topic` and `probability` (although the
 * probability is often times just `1`).
 *
 * @param  {Object} o    The options for this instance of fuzzy weather
 * @param  {Object} data Daily summary data as returned from Dark Sky API
 * @return {Array}       Sorted conditions, each entry being an object with:
 *                       - topic {String} for example: "rain", "wind", "clouds"
 *                       - probability {Number} percentage represented as 0-1
 *                       - level {Number} The severity from 1-10 (could be outside of this)
 */
function getDailyConditions(o, data) {
    let avgTemps = o.avgTemps[(new Date(data.time * 1000)).getMonth()],
        conditions = [];

    // -------- RAIN
    if (data.precipType === 'rain' && data.precipProbability > 0.1 && data.precipIntensityMax > 0.01) {
        conditions.push({
            topic: 'rain',
            probability: data.precipProbability,
            level: (data.precipIntensityMax * 10) * 2
        });

    // -------- SNOW
    } else if (data.precipType === 'snow' && data.precipProbability > 0.1 && data.precipIntensityMax > 0.005) {
        let level = (1 - data.visibility);
        if (level < 1) {
            // if visibility isn't indicative, let's use precipAccumulation
            level = data.precipAccumulation;
        }

        conditions.push({
            topic: 'snow',
            probability: data.precipProbability,
            level: level
        });

    // -------- SLEET
    } else if (data.precipType === 'sleet' && data.precipProbability > 0.1 && data.precipIntensityMax > 0.05) {
        conditions.push({
            topic: 'snow',
            probability: data.precipProbability,
            level: data.precipAccumulation * 10
        });

    // -------- HEAT (and humidity)
    } else if (data.temperatureMax > avgTemps.high || data.apparentTemperatureMax > (avgTemps.high + 5)) {
        let level = Math.max((data.temperatureMax - avgTemps.high), (data.apparentTemperatureMax - avgTemps.high));
        if (data.dewPoint > o.dewPointBreak || data.humidity > o.humidityBreak) {
            level += ((data.dewPoint - o.dewPointBreak) + (data.humidity - o.humidityBreak)) / 2;
        }

        conditions.push({
            topic: (data.dewPoint > o.dewPointBreak || data.humidity > o.humidityBreak) ? 'heat-humid' : 'heat',
            probability: 1,
            level: level
        });

    // -------- HUMIDITY
    } else if (data.dewPoint > (o.dewPointBreak * 0.90) && data.humidity > (o.humidityBreak * 0.90)) {
        conditions.push({
            topic: 'humidity',
            probability: 1,
            level: (data.dewPoint - o.dewPointBreak) + (data.humidity - o.humidityBreak)
        });

    // -------- COLD (and windy)
    } else if (data.temperatureMin < avgTemps.low || data.apparentTemperatureMin < (avgTemps.low - 5)) {
        let level = Math.max((avgTemps.low - data.temperatureMin), (avgTemps.low - data.apparentTemperatureMin));
        if (data.windSpeed > o.windBreak) {
            level += ((data.windSpeed - o.windBreak) / 5);
        }

        conditions.push({
            topic: (data.windSpeed > o.windBreak) ? 'cold-wind' : 'cold',
            probability: 1,
            level: level
        });

    // -------- CLOUDS
    } else if (data.cloudCover > o.cloudBreak) {
        conditions.push({
            topic: 'clouds',
            probability: 1,
            level: (data.cloudCover - o.cloudBreak) * 50
        });

    // -------- WIND
    } else if (data.windSpeed > o.windBreak) {
        conditions.push({
            topic: 'wind',
            probability: 1,
            level: (data.windSpeed - o.windBreak) / 2
        });
    }

    return conditions.sort(function(a, b) {
        return b.level - a.level;
    });
}


/* ****************************************************** *
                 VARIOUS HELPER METHODS
 * ****************************************************** */

function render(text, data) {
    var newText = text;
    Object.keys(data).forEach(function(key) {
        newText = text.replace('{' + key + '}', data[key]);
    });
    return newText;
}

function getDayOfWeek(date, useFamiliar) {
    let now = Date.now();
    let day = 'that day';

    if (useFamiliar && moment(date).format('YYYY-MM-DD') === moment(now).format('YYYY-MM-DD')) {
        day = 'today';
    } else if (useFamiliar && moment(date).format('YYYY-MM-DD') === moment(now + (1000*60*60*24)).format('YYYY-MM-DD')) {
        day = 'tomorrow';
    } else {
        day = moment(date).format('dddd');
    }
    return day;
}
