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
//コンテンツと端末の管理 > 端末 tab
//const AFTER_LOGIN_WAIT = '.contentApp_myx > div:nth-child(1) > div:nth-child(1)';
const AFTER_LOGIN_WAIT = '.nav-tabs > li:nth-child(2) > div:nth-child(1)';
const CONSOLE_MENU_OPEN = '.nav-tabs > li:nth-child(2) > div:nth-child(1) > div:nth-child(1) > a:nth-child(1)';
const CONSOLE_DETAIL_WAIT = 'div.ng-isolate-scope:nth-child(4)';
const FIRST_CONSOLE_EVENT = '.scroller-content > div:nth-child(1) > ul:nth-child(1) > li:nth-child(1)';
const SECOND_CONSOLE_EVENT = '.scroller-content > div:nth-child(1) > ul:nth-child(1) > li:nth-child(2) > div:nth-child(1) > div:nth-child(1) > a:nth-child(1)';
const APP_GAME_EVENT = '.parental-dashboard-content > div:nth-child(2) > a:nth-child(1)';
const APP_GAME_WAIT = '.parental-dashboard-content > div:nth-child(2) > div:nth-child(2)';

const PAUSE_TIME = 8000;

var iPauseTime = PAUSE_TIME;
var strMessageForSend = '';
var strUserMail = '';
var strPassword = '';
var strLineAccessToken = '';
var strLineMinGroupId = '';
var isNeedSend = false;
var iPreviousUsageSecond = 0;
var iPreviousUsageFirst = 0;
var iLimitMinute = 180;
var strNameFirst = '妹';
var strNameSecond = '兄';


/**
 * set enviroment value
 *
 */
function init(){
    if(process.env.USER_MAIL.trim() == '' || process.env.USER_MAIL == null){
        setIntValueFromDB();
    }else{
        console.log('use env:' + process.env.USER_MAIL);
        strUserMail = process.env.USER_MAIL;
        strPassword = process.env.PASSWORD;
        strLineAccessToken = process.env.LINE_ACCESS_TOKEN;
        strLineMinGroupId = process.env.LINE_MIN_GROUP_ID;
        iPauseTime = parseInt(process.env.PAUSE_TIME);
        iLimitMinute = parseInt(process.env.LIMIT_MINUTE);
        strNameFirst = process.env.FIRST_NAME;
        strNameSecond = process.env.SECOND_NAME;

        setDBfromUsageMinute(getNowDate(), execWebdriver);
    }
}

/**
* 初期データをDBから取得
*
*/
function setIntValueFromDB(){
    var params = {
        'RequestItems': {
            'users' :{
            Keys: [
                {'domain': {S :'amazon'}},
                {'domain': {S :'line_access_token'}},
                {'domain': {S :'line_min_group'}},
            ]
            }
        }
    };

    DYNAMODB.batchGetItem(params, function (err, res) {
        if(err){
            console.log('error: '+ err);
        }

        var result = res.Responses.users.filter(function(item, index){
            switch(item.domain.S){
                case 'amazon' :
                    strUserMail = item.id.S;
                    strPassword = item.password.S;
                    break;
                case 'line_access_token' :
                    strLineAccessToken = 'Bearer ' + item.id.S;
                    break;
                case 'line_min_group' :
                    strLineMinGroupId = item.id.S;
                    break;
            }
        });

        //set env value
        process.env.USER_MAIL = strUserMail;
        process.env.PASSWORD = strPassword;
        process.env.LINE_ACCESS_TOKEN = strLineAccessToken;
        process.env.LINE_MIN_GROUP_ID = strLineMinGroupId;
        console.log("env:" + process.env.LINE_MIN_GROUP_ID);

        setDBfromUsageMinute(getNowDate(), execWebdriver);
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
        .deleteCookie()
        .url(AMAZON_URL)
        .setValue('input[name="email"]', strUserMail)
        .click('input[id="continue"]')
        .setValue('input[name="password"]', strPassword)
        .click('input[id="signInSubmit"]')
        //.waitForExist(AFTER_LOGIN_WAIT, iPauseTime)
        .pause(iPauseTime + 1500)
        .getSource().then(source => {
            console.log('after login:' + source);
        })
        .click(CONSOLE_MENU_OPEN)
        .pause(iPauseTime + 1500)
        .click(APP_GAME_EVENT)
        .getSource().then(source => {
            console.log('getSource:' + strNameFirst);
            printUseTimes(strNameFirst, source);
        })
        .click(SECOND_CONSOLE_EVENT)
        .pause(iPauseTime)
        .click(APP_GAME_EVENT)
        .getSource().then(source => {
            console.log('getSource:' + strNameSecond);
            printUseTimes(strNameSecond, source);
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

    var strSubMessage = '';

    //analize second tab
    var eleNames = dom.getElementsByClassName('activityTitle');
    var eleValues = dom.getElementsByClassName('activityDuration ng-binding');

    for(var nameNo in eleNames){
        var eleName = eleNames[nameNo].textContent.trim();
        var eleSplitNames = eleName.split(' ');

        var eleValue = eleValues[nameNo].textContent;
        eleValue = eleValue.replace('&lt;', '');
        strSubMessage += '  ' + eleSplitNames[0] + ':' + eleValue + "\n";
    }

    var strMessage = pName + ':' + getUsageTimeMessage(iTotalMin) + "\n" + strSubMessage;
    console.log(strMessage);

    if(strMessageForSend.length > 0){
        strMessageForSend += "\n";
    }

    strMessageForSend += strMessage;

    var isAdded = false;

    if(pName == strNameFirst){
        if(iPreviousUsageFirst == 0 || iTotalMin == 0 || iTotalMin > parseInt(iPreviousUsageFirst) + 60){
            updateUsageTime(pName, iTotalMin);
            isAdded = true;
        }
    }

    if(pName == strNameSecond){
        if(iPreviousUsageSecond == 0 || iTotalMin == 0 || iTotalMin > parseInt(iPreviousUsageSecond) + 60){
            updateUsageTime(pName, iTotalMin);
            isAdded = true;
        }
    }

    if(isAdded && iTotalMin > iLimitMinute){
        isNeedSend = true;
    }
}


/**
* 分を文字列の時分に変える
*
* @param {int} pTotalMin
*/
function getUsageTimeMessage(pTotalMin){
    var iHour = 0;
    var iMin = 0;
    var strHour = '';
    var strMin = '';

    iHour = parseInt(pTotalMin / 60);

    if(iHour > 0){
        iMin = pTotalMin % 60;
    }else{
        iMin = pTotalMin;
    }

    var strHour = '';
    var strMin = '';

    if(iHour > 0){
        strHour = String(iHour) + '時間';
    }

     if(iMin > 0){
        strMin = String(iMin) + '分';
    }

    return strHour + strMin;
}


/**
* 履歴テーブルを更新する
*
* @param {string} pName
* @param {int} pTotalMin
*/
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
* DynamoDBから指定した日付の時間を取得
*
* @param {string} pName
* @param {string} pCallBack
*/
function setDBfromUsageMinute(pSearchDate, pCallBack){
    var params = {
        TableName: 'daliy_usage_minute',
        KeyConditionExpression: "#hash = :str",
        ExpressionAttributeNames:{
            "#hash": "use_date"
        },
        ExpressionAttributeValues: {
            ":str": {"S" : pSearchDate}
        }
    };

    DYNAMODB.query(params, function (err, res) {
        if (err) {
            console.log(err, err.stack);
        } else {
            if(res.Items.length > 1){
                switch (pSearchDate){
                    case getNowDate():
                        iPreviousUsageFirst = parseInt(res.Items[0].usage_minute.N);
                        iPreviousUsageSecond = parseInt(res.Items[1].usage_minute.N);
                        console.log("1st previous minute:" + iPreviousUsageFirst);
                        console.log("2nd previous minute:" + iPreviousUsageSecond);
                        break;
                    case getYesterDate():
                        var yesterDayUsageMessage = "先日の利用時間\n" 
                                + strNameFirst + ":" + getUsageTimeMessage(parseInt(res.Items[0].usage_minute.N)) + "\n"
                                + strNameSecond + ":" + getUsageTimeMessage(parseInt(res.Items[1].usage_minute.N));
                        sendToLine(yesterDayUsageMessage);
                        return;
                        break;
                    default:
                        console.log('not match date');
                        break;
                }
            }else{
                //今日の日付のデータがなかったら、昨日の利用時間を調査する
                //次回実行時にまだこの分岐に来ないよう、今日の時間を0分として登録する
                console.log("no previous minute");
                console.log("yesterday is:" + getYesterDate());

                updateUsageTime(strNameFirst, 0);
                updateUsageTime(strNameSecond, 0);

                setDBfromUsageMinute(getYesterDate());
            }

            if(pCallBack != null){
                pCallBack();
            }
        }
    });
}


/**
* メッセージをLINEに送信
*
* @param {string} pMessage
*/
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

/**
* 現在日付をYYYYMMDDで表示
*
*/
function getNowDate(){
    var date = new Date();
    return date.getFullYear() + '' +  getZeroPadding(date.getMonth() + 1) + getZeroPadding(date.getDate());
}

/**
* 翌日日付をYYYYMMDDで表示
*
*/
function getYesterDate(){
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.getFullYear() + '' +  getZeroPadding(yesterday.getMonth() + 1) + getZeroPadding(yesterday.getDate());
}

/**
* 現在の日時をYYYYMMDD HH:MM:SSで表示
*
*/
function getNowDateTime(){
    var date = new Date();
    return getNowDate() + getZeroPadding(date.getHours()) + getZeroPadding(date.getMinutes()) + getZeroPadding(date.getSeconds());
}

/**
* 日付用の0パーディング
*
* @param {string} pNumber
*/
function getZeroPadding(pNumber){
    return ('00' + (pNumber)).slice(-2);
}

module.exports.scrape = (event, context, callback) => {
    init();
};
