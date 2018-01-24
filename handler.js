'use strict';

const PHANTOMJS = require('phantomjs-prebuilt');
const WEBDRIVERIO = require('webdriverio');
const WDOPTS = { desiredCapabilities: { browserName: 'phantomjs',
                                      'phantomjs.page.settings.userAgent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:57.0) Gecko/20100101 Firefox/57.0 WebKit',
                                        platform: 'MAC',
                                      javascriptEnabled: true
                                    }
};

const HTTPS = require('https');

const AWS = require('aws-sdk');
const DYNAMODB = new AWS.DynamoDB({region: 'ap-northeast-1'});

const DOMParser = require('dom-parser');

const AMAZON_URL = 'https://www.amazon.co.jp/gp/digital/fiona/manage/ref=nav_youraccount_myk';
const AFTER_LOGIN_WAIT = '.contentApp_myx > div:nth-child(1) > div:nth-child(1)';
const CONSOLE_MENU_OPEN = '.nav-tabs > li:nth-child(2) > div:nth-child(1) > div:nth-child(1) > a:nth-child(1)';
const CONSOLE_DETAIL_WAIT = 'div.ng-isolate-scope:nth-child(4)';
const FIRST_CONSOLE_EVENT = '.scroller-content > div:nth-child(1) > ul:nth-child(1) > li:nth-child(1)';
const SECOND_CONSOLE_EVENT = '.scroller-content > div:nth-child(1) > ul:nth-child(1) > li:nth-child(2) > div:nth-child(1) > div:nth-child(1) > a:nth-child(1)';
const APP_GAME_WAIT = '.parental-dashboard-content > div:nth-child(2) > div:nth-child(2)';

const NAME_TOMO = 'とも';
const NAME_YUKI = 'ゆき';
const PAUSE_TIME = 5000;

var iPauseTime = PAUSE_TIME;
var strMessageForSend = '';
var strUserMail = '';
var strPassword = '';
var strLineAccessToken = '';
var strLineMinGroupId = '';
var isNeedSend = false;
var iPreviousUsageYuki = 0;
var iPreviousUsageTomo = 0;
var iLimitMinute = 180;

/**
* set enviroment value
*
**/
function init(){
    if(process.env.USER_MAIL == null){
        setIntValueFromDB();
    }else{
        console.log('use env:' + process.env.USER_MAIL);
        strUserMail = process.env.USER_MAIL;
        strPassword = process.env.PASSWORD;
        strLineAccessToken = process.env.LINE_ACCESS_TOKEN;
        strLineMinGroupId = process.env.LINE_MIN_GROUP_ID;
        iPauseTime = parseInt(process.env.PAUSE_TIME);
        iLimitMinute = parseInt(process.env.LIMIT_MINUTE);

        setPreUsageMinute();
    }
}


function setIntValueFromDB(){
    var params = {
        TableName: 'users',
        Key: {
            'domain': {S :'amazon'}
        }
    };

    DYNAMODB.getItem(params, function (err, res) {
        strUserMail = res.Item.id.S;
        strPassword = res.Item.password.S;

        console.log('dynamoDB:' + strUserMail);

        var params = {
            TableName: 'users',
            Key: {
                'domain': {S :'line_access_token'}
            }
        };

        DYNAMODB.getItem(params, function (err, res) {
            strLineAccessToken = 'Bearer ' + res.Item.id.S;

            params = {
                TableName: 'users',
                Key: {
                    'domain': {S :'line_min_group'}
                }
            };

            DYNAMODB.getItem(params, function (err, res) {
                strLineMinGroupId = res.Item.id.S;

                //set env value
                process.env.USER_MAIL = strUserMail;
                process.env.PASSWORD = strPassword;
                process.env.LINE_ACCESS_TOKEN = strLineAccessToken;
                process.env.LINE_MIN_GROUP_ID = strLineMinGroupId;
                console.log("env:" + process.env.LINE_MIN_GROUP_ID);

                setPreUsageMinute();
            });
        });
    });
}


/**
* amazon scraping
*
**/
function execWebdriver(){
    console.log('start phantomjs:' + strUserMail);
    PHANTOMJS.run('--webdriver=4444').then(program => {
        var client = WEBDRIVERIO.remote(WDOPTS);
        client.init()
        .url(AMAZON_URL)
        .setValue('input[name="email"]', strUserMail)
        .setValue('input[name="password"]', strPassword)
        .click('input[id="signInSubmit"]')
        .waitForExist(AFTER_LOGIN_WAIT, PAUSE_TIME)
        .click(CONSOLE_MENU_OPEN)
        .pause(iPauseTime + 1500)
    //    .waitForExist(CONSOLE_DETAIL_WAIT)
        .getSource().then(source => {
            console.log('getSource' + NAME_TOMO);
            printUseTimes(NAME_TOMO, source);
        })
        .click(SECOND_CONSOLE_EVENT)
        .pause(iPauseTime)
        .getSource().then(source => {
            console.log('getSource' + NAME_YUKI);
            printUseTimes(NAME_YUKI, source);
        })
        .end().then(function(){
            //ここでcookieを消すと
            //A session id is required for this command but wasn't found in the response payload
            //になる。
            //
            //@see https://github.com/webdriverio/webdriverio/issues/968
            //if you call end you can't execute more commands because your session and browser got closed.
            console.log('isNeedLineSend:' + isNeedSend);
            if(isNeedSend){
                sendToLine(strMessageForSend);
            }
            program.kill(); // quits PhantomJS
        })
        .catch((err) => {
            console.error('client error: ' + err);
            program.kill();
            return Promise.reject(err);
        });
    })
    .catch((err) => {
        console.error('failed: ' + err);
        context.fail({
            statusCode: 500,
            body: JSON.stringify({ "message": 'failed: ' + err })
        });
    });
}


/**
* 端末の使用時間を表示
*
* @param {string} pName
* @param {string} pSource
**/
function printUseTimes(pName, pSource){
    var parser = new DOMParser();
    var dom = parser.parseFromString(pSource, 'text/xml');
    var eleNames = dom.getElementsByClassName('a-size-base-plus pmd-category-title ng-binding');
    var eleValues = dom.getElementsByClassName('category-duration ng-binding');
    var iTotalMin = 0;
    var iHour = 0;
    var iMin = 0;

    for(var nameNo in eleNames){
        var eleName = eleNames[nameNo].textContent;
        var eleValue = eleValues[nameNo].textContent;

        var eleValueMin = eleValue.match(/^\D*(\d+)分.*$/);

        if(eleValueMin == null){
            eleValueMin = eleValue.match(/^(\d+)時間(\d+)分.*$/);

            if(eleValueMin != null){
                iTotalMin += parseInt(eleValueMin[1]) * 60 + parseInt(eleValueMin[2]);
            }
        }else{
            iTotalMin += parseInt(eleValueMin[1]);
        }
    }

    iHour = parseInt(iTotalMin / 60);

    if(iHour > 0){
        iMin = iTotalMin % 60;
    }else{
        iMin = iTotalMin;
    }

    var strHour = '';
    var strMin = '';

    if(iHour > 0){
        strHour = String(iHour) + '時間';
    }

     if(iMin > 0){
        strMin = String(iMin) + '分';
    }

    var strMessage = pName + ':' + strHour + strMin + "\n";
    console.log(strMessage);
    strMessageForSend += strMessage;

    var isAdded = false;

    if(pName == NAME_TOMO){
        if(iPreviousUsageTomo == 0 || iTotalMin > iPreviousUsageTomo + 60){
            updateUsageTime(pName, iTotalMin);
            isAdded = true;
        }
    }

    if(pName == NAME_YUKI){
        if(iPreviousUsageYuki == 0 || iTotalMin > iPreviousUsageYuki + 60){
            updateUsageTime(pName, iTotalMin);
            isAdded = true;
        }
    }

    if(isAdded && iTotalMin > iLimitMinute){
        isNeedSend = true;
    }
}


function updateUsageTime(pName, pTotalMin){
    //Number型でもstringにするべきらしい
    //message: 'Expected params.Item[\'usage_minute\'].N to be a string',
    //  code: 'InvalidParameterType'
    //https://hibara.org/blog/2013/09/22/dynamodb-putitem-number/
    var strTotalMin = String(pTotalMin);

    var params = {
        TableName: 'daliy_usage_minute',
        Item: {
            'use_date': {S :getNowDate()},
            'name': {S :pName},
            'usage_minute': {N: strTotalMin},
            'last_updated': {S: getNowDateTime()}
        }
    };

    DYNAMODB.putItem(params, function (err, res) {
        if (err) {
            console.log(err, err.stack);
        }
    });
}

/**
*
*
* @param string pName
**/
function setPreUsageMinute(pName){
    console.log("datetime:" + getNowDateTime());

    var params = {
        TableName: 'daliy_usage_minute',
        KeyConditionExpression: "#hash = :str",
        ExpressionAttributeNames:{
            "#hash": "use_date"
        },
        ExpressionAttributeValues: {
            ":str": {"S" : getNowDate()}
        }
    };

    DYNAMODB.query(params, function (err, res) {
        if (err) {
            console.log(err, err.stack);
        } else {
            if(res.Items.length > 1){
                iPreviousUsageTomo = parseInt(res.Items[0].usage_minute.N);
                iPreviousUsageYuki = parseInt(res.Items[1].usage_minute.N);
                console.log("tomo previous minute:" + iPreviousUsageTomo);
                console.log("yuki previous minute:" + iPreviousUsageYuki);
            }else{
                console.log("no previous minute");
            }

            execWebdriver();
        }
    });
}


/**
* メッセージをLINEに送信
*
* @param string pMessage
**/
function sendToLine(pMessage){
    var opts = {
        hostname: 'api.line.me',
        path: '/v2/bot/message/push',
        headers: {
            "Content-type": "application/json; charset=UTF-8",
            "Authorization": strLineAccessToken
        },
        method: 'POST',
    };

    var data = JSON.stringify({
        to: strLineMinGroupId,
        messages: [{type: "text", text: pMessage}]
    });

    var req = HTTPS.request(opts, function(res) {
        res.on('data', function(res) {
            //console.log("RESPONSE:" + res.toString());
        }).on('error', function(e) {
            console.log('ERROR: ' + e.stack);
        });
    });

    req.write(data);
    req.end(function(){
        //必要であればログを書く
    });
}

//date is not defined
function getNowDate(){
    var date = new Date();
    return date.getFullYear() + '' +  getZeroPadding(date.getMonth() + 1) + getZeroPadding(date.getDate());
}

function getNowDateTime(){
    var date = new Date();
    return getNowDate() + getZeroPadding(date.getHours()) + getZeroPadding(date.getMinutes()) + getZeroPadding(date.getSeconds());
}

function getZeroPadding(pNumber){
    return ('00' + (pNumber)).slice(-2);
}

module.exports.scrape = (event, context, callback) => {
    init();
};
