'use strict';

require('dotenv').config();

const http = require('http');
const { SerialPort } = require('serialport');

const {
    parseWeight,
} = require('./scale-parser');

const SCALE_DEVICE =
    process.env.SCALE_DEVICE ||
    '/dev/torrey-scale';

const SCALE_BAUDRATE =
    Number(process.env.SCALE_BAUDRATE || 9600);

const SCALE_TIMEOUT =
    Number(process.env.SCALE_TIMEOUT || 1000);

const LABEL_PRINTER_URL =
    process.env.LABEL_PRINTER_URL ||
    'http://127.0.0.1:8080';

const LABEL_PRINTER_TOKEN =
    process.env.LABEL_PRINTER_TOKEN ||
    '';

const PORT =
    Number(process.env.SCALE_SERVER_PORT || 8090);


/*
 * --------------------------------------------------
 * Current product
 * --------------------------------------------------
 *
 * The POS sets this before weighing.
 */
let currentProduct = null;


/*
 * --------------------------------------------------
 * Last scale reading
 * --------------------------------------------------
 */

let lastReading = {
    weight: null,
    unit: 'kg',
    raw: null,
    timestamp: null,
};


/*
 * --------------------------------------------------
 * Serial port
 * --------------------------------------------------
 */

const serial = new SerialPort({
    path: SCALE_DEVICE,
    baudRate: SCALE_BAUDRATE,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    autoOpen: false,
});


/*
 * --------------------------------------------------
 * Serial data buffer
 * --------------------------------------------------
 */

let serialBuffer = '';


serial.on('data', chunk => {

    serialBuffer += chunk.toString('ascii');

    /*
     * Torrey messages are terminated by CR.
     */
    const messages = serialBuffer.split('\r');

    /*
     * Keep incomplete message.
     */
    serialBuffer = messages.pop();

    for (const message of messages) {

        const reading =
            parseWeight(message);

        if (!reading) {
            continue;
        }

        handleWeight(reading);
    }
});


serial.on('error', error => {

    console.error(
        '[SCALE] Serial error:',
        error.message
    );
});


serial.on('open', () => {

    console.log(
        `[SCALE] Connected: ${SCALE_DEVICE}`
    );

    console.log(
        `[SCALE] Baud rate: ${SCALE_BAUDRATE}`
    );
});


serial.on('close', () => {

    console.log(
        '[SCALE] Serial connection closed'
    );
});


/*
 * --------------------------------------------------
 * Handle weight
 * --------------------------------------------------
 */

async function handleWeight(reading) {

    lastReading = {
        ...reading,
        timestamp: new Date().toISOString(),
    };

    console.log(
        `[SCALE] Weight: ${reading.weight} ${reading.unit}`
    );

    /*
     * Don't automatically print unless a product
     * has been selected by the POS.
     */
    if (!currentProduct) {

        console.log(
            '[SCALE] No product selected. ' +
            'Weight will not be printed.'
        );

        return;
    }

    try {

        await printLabel({
            product: currentProduct,
            weight: reading.weight,
            unit: reading.unit,
        });

    } catch (error) {

        console.error(
            '[SCALE] Label printing failed:',
            error.message
        );
    }
}


/*
 * --------------------------------------------------
 * Ask scale for current weight
 * --------------------------------------------------
 *
 * Torrey L-EQ PC protocol:
 *
 * P
 */
function requestWeight() {

    return new Promise((resolve, reject) => {

        if (!serial.isOpen) {
            return reject(
                new Error('Scale serial port is not open.')
            );
        }

        let buffer = '';

        const timeout =
            setTimeout(() => {

                cleanup();

                reject(
                    new Error(
                        'Timeout waiting for scale response.'
                    )
                );

            }, SCALE_TIMEOUT);


        function cleanup() {

            clearTimeout(timeout);

            serial.off(
                'data',
                onData
            );
        }


        function onData(chunk) {

            buffer += chunk.toString('ascii');

            if (!buffer.includes('\r')) {
                return;
            }

            cleanup();

            const reading =
                parseWeight(buffer);

            if (!reading) {

                return reject(
                    new Error(
                        `Invalid scale response: ${JSON.stringify(buffer)}`
                    )
                );
            }

            lastReading = {
                ...reading,
                timestamp: new Date().toISOString(),
            };

            resolve(reading);
        }


        serial.on(
            'data',
            onData
        );


        /*
         * Ask the Torrey for the current weight.
         */
        serial.write(
            'P',
            error => {

                if (error) {

                    cleanup();

                    reject(error);
                }
            }
        );
    });
}


/*
 * --------------------------------------------------
 * Print label
 * --------------------------------------------------
 */

async function printLabel({
    product,
    weight,
    unit,
}) {

    const payload = {

        product: {
            id: product.id,
            name: product.name,
            barcode: product.barcode,
        },

        quantity: weight,

        unit,

        /*
         * Tell the label printer that this is a
         * scale-generated label.
         */
        source: 'torrey-scale',
    };


    console.log(
        '[LABEL] Printing:',
        JSON.stringify(payload)
    );


    const response =
        await fetch(
            `${LABEL_PRINTER_URL}/print-label`,
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json',

                    ...(LABEL_PRINTER_TOKEN
                        ? {
                            Authorization:
                                `Bearer ${LABEL_PRINTER_TOKEN}`,
                        }
                        : {}),
                },

                body:
                    JSON.stringify(payload),
            }
        );


    const body =
        await response.text();


    if (!response.ok) {

        throw new Error(
            `Label printer returned ` +
            `${response.status}: ${body}`
        );
    }


    console.log(
        '[LABEL] Printed successfully.'
    );


    return body;
}


/*
 * --------------------------------------------------
 * HTTP helpers
 * --------------------------------------------------
 */

function readRequestBody(req) {

    return new Promise((resolve, reject) => {

        let body = '';

        req.on(
            'data',
            chunk => {

                body += chunk;

                /*
                 * Protect against accidentally huge
                 * requests.
                 */
                if (body.length > 1024 * 1024) {

                    reject(
                        new Error(
                            'Request body too large.'
                        )
                    );

                    req.destroy();
                }
            }
        );


        req.on(
            'end',
            () => {

                if (!body) {
                    return resolve({});
                }

                try {

                    resolve(
                        JSON.parse(body)
                    );

                } catch (error) {

                    reject(
                        new Error(
                            'Invalid JSON body.'
                        )
                    );
                }
            }
        );


        req.on(
            'error',
            reject
        );
    });
}


/*
 * --------------------------------------------------
 * HTTP server
 * --------------------------------------------------
 */

const server =
    http.createServer(
        async (req, res) => {

            try {

                /*
                 * --------------------------------------
                 * Health
                 * --------------------------------------
                 */

                if (
                    req.method === 'GET' &&
                    req.url === '/health'
                ) {

                    return sendJson(
                        res,
                        200,
                        {
                            success: true,

                            scale: {
                                connected:
                                    serial.isOpen,

                                device:
                                    SCALE_DEVICE,

                                baudRate:
                                    SCALE_BAUDRATE,
                            },

                            lastReading,
                        }
                    );
                }


                /*
                 * --------------------------------------
                 * Current weight
                 * --------------------------------------
                 */

                if (
                    req.method === 'GET' &&
                    req.url === '/scale/weight'
                ) {

                    if (!serial.isOpen) {

                        return sendJson(
                            res,
                            503,
                            {
                                success: false,
                                error:
                                    'Scale is not connected.',
                            }
                        );
                    }


                    const reading =
                        await requestWeight();


                    return sendJson(
                        res,
                        200,
                        {
                            success: true,
                            ...reading,
                        }
                    );
                }


                /*
                 * --------------------------------------
                 * Select product
                 * --------------------------------------
                 */

                if (
                    req.method === 'POST' &&
                    req.url === '/scale/product'
                ) {

                    const body =
                        await readRequestBody(req);


                    if (
                        !body.name ||
                        !body.barcode
                    ) {

                        return sendJson(
                            res,
                            422,
                            {
                                success: false,
                                error:
                                    'Product name and barcode are required.',
                            }
                        );
                    }


                    currentProduct = {

                        id:
                            body.id ??
                            null,

                        name:
                            String(body.name),

                        barcode:
                            String(body.barcode),
                    };


                    console.log(
                        '[SCALE] Product selected:',
                        currentProduct
                    );


                    return sendJson(
                        res,
                        200,
                        {
                            success: true,
                            product:
                                currentProduct,
                        }
                    );
                }


                /*
                 * --------------------------------------
                 * Clear product
                 * --------------------------------------
                 */

                if (
                    req.method === 'DELETE' &&
                    req.url === '/scale/product'
                ) {

                    currentProduct = null;

                    return sendJson(
                        res,
                        200,
                        {
                            success: true,
                        }
                    );
                }


                /*
                 * --------------------------------------
                 * Print using current weight
                 * --------------------------------------
                 */

                if (
                    req.method === 'POST' &&
                    req.url === '/scale/print'
                ) {

                    if (!currentProduct) {

                        return sendJson(
                            res,
                            409,
                            {
                                success: false,
                                error:
                                    'No product selected.',
                            }
                        );
                    }


                    const reading =
                        await requestWeight();


                    await printLabel({

                        product:
                            currentProduct,

                        weight:
                            reading.weight,

                        unit:
                            reading.unit,
                    });


                    return sendJson(
                        res,
                        200,
                        {
                            success: true,

                            product:
                                currentProduct,

                            weight:
                                reading.weight,

                            unit:
                                reading.unit,
                        }
                    );
                }


                /*
                 * --------------------------------------
                 * 404
                 * --------------------------------------
                 */

                return sendJson(
                    res,
                    404,
                    {
                        success: false,
                        error: 'Not found.',
                    }
                );

            } catch (error) {

                console.error(
                    '[HTTP]',
                    error
                );

                return sendJson(
                    res,
                    500,
                    {
                        success: false,
                        error:
                            error.message,
                    }
                );
            }
        }
    );


/*
 * --------------------------------------------------
 * JSON response
 * --------------------------------------------------
 */

function sendJson(
    res,
    status,
    data
) {

    res.writeHead(
        status,
        {
            'Content-Type':
                'application/json',

            'Cache-Control':
                'no-store',
        }
    );

    res.end(
        JSON.stringify(data)
    );
}


/*
 * --------------------------------------------------
 * Open scale
 * --------------------------------------------------
 */

function openScale() {

    if (serial.isOpen) {
        return;
    }

    serial.open(
        error => {

            if (error) {

                console.error(
                    '[SCALE] Unable to open:',
                    error.message
                );

                process.exitCode = 1;

                return;
            }
        }
    );
}


/*
 * --------------------------------------------------
 * Start
 * --------------------------------------------------
 */

openScale();


server.listen(
    PORT,
    '127.0.0.1',
    () => {

        console.log('');
        console.log(
            '=========================================='
        );

        console.log(
            ' Torrey Scale Service'
        );

        console.log(
            '=========================================='
        );

        console.log(
            ` Device : ${SCALE_DEVICE}`
        );

        console.log(
            ` Baud   : ${SCALE_BAUDRATE}`
        );

        console.log(
            ` HTTP   : http://127.0.0.1:${PORT}`
        );

        console.log(
            '=========================================='
        );

        console.log('');
    }
);


/*
 * --------------------------------------------------
 * Shutdown
 * --------------------------------------------------
 */

function shutdown() {

    console.log(
        '[SYSTEM] Shutting down...'
    );


    if (serial.isOpen) {
        serial.close();
    }


    server.close(
        () => process.exit(0)
    );
}


process.on(
    'SIGINT',
    shutdown
);

process.on(
    'SIGTERM',
    shutdown
);

