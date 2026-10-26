'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const {
    CONFIG,
    buildProductLabel,
    printProductLabel,
} = require('./label-printer');

const {
    deviceExists,
    checkDevice,
    PrinterError,
} = require('./usb-printer-transport');

const ScaleReader =
    require('./scale-reader');

const app =
    express();

/*
|--------------------------------------------------------------------------
| Server configuration
|--------------------------------------------------------------------------
*/

const HOST =
    process.env.PRINTER_SERVER_HOST ||
    '127.0.0.1';

const PORT =
    Number(
        process.env.PRINTER_SERVER_PORT ||
        3100
    );

/*
|--------------------------------------------------------------------------
| Scale configuration
|--------------------------------------------------------------------------
*/

const SCALE_ENABLED =
    String(
        process.env.SCALE_ENABLED ||
        'false'
    ).toLowerCase() === 'true';

const SCALE_DEVICE =
    process.env.SCALE_DEVICE ||
    '/dev/torrey-scale';

const SCALE_BAUD_RATE =
    Number(
        process.env.SCALE_BAUD_RATE ||
        9600
    );

const SCALE_DATA_BITS =
    Number(
        process.env.SCALE_DATA_BITS ||
        8
    );

const SCALE_STOP_BITS =
    Number(
        process.env.SCALE_STOP_BITS ||
        1
    );

const SCALE_PARITY =
    process.env.SCALE_PARITY ||
    'none';

const SCALE_MIN_WEIGHT_KG =
    Number(
        process.env.SCALE_MIN_WEIGHT_KG ||
        0.001
    );

const SCALE_DECIMAL_PLACES =
    Number(
        process.env.SCALE_DECIMAL_PLACES ||
        3
    );

/*
|--------------------------------------------------------------------------
| Express
|--------------------------------------------------------------------------
*/

app.disable(
    'x-powered-by'
);

app.use(cors({
    origin: true, // Dynamically reflects http://127.0.0.1:8000
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type', 
        'Accept', 
        'X-Requested-With', 
        'X-CSRF-TOKEN', 
        'x-csrf-token'
    ]
}));

app.use(
    express.json({
        limit: '64kb',
    })
);

/*
|--------------------------------------------------------------------------
| Print queue
|--------------------------------------------------------------------------
|
| Direct USB jobs must never be written
| simultaneously.
|
*/

let queue =
    Promise.resolve();

function enqueuePrint(
    callback
) {
    const job =
        queue.then(
            callback
        );

    /*
     * Do not leave a rejected Promise
     * as the queue head.
     */

    queue =
        job.catch(
            () => {}
        );

    return job;
}

/*
|--------------------------------------------------------------------------
| Scale & Streaming State Management
|--------------------------------------------------------------------------
*/

let scale = null;
let pendingScaleLabel = null;
let lastKnownWeight = null; // Caches the latest weight for the UI button
let sseClients = [];        // Connected browser clients for SSE

/*
|--------------------------------------------------------------------------
| Shared Print Execution Helper
|--------------------------------------------------------------------------
*/

function executePrint(weight) {
    if (!pendingScaleLabel) {
        console.log('[scale] No product is armed.');
        return;
    }

    if (!Number.isFinite(weight.weightKg) || weight.weightKg <= 0) {
        console.warn('[scale] Invalid weight for printing.');
        return;
    }

    const product = pendingScaleLabel;
    //pendingScaleLabel = null; // Consume immediately to prevent duplicate prints

    const quantity = formatScaleQuantity(weight);
    const weightInGrams = Math.round(weight.weightKg * 1000);
    const dynamicBarcode = `${product.barcode}-${weightInGrams.toString().padStart(4, '0')}`;

    const printRequest = {
        productName: product.productName,
        quantity,
        barcode: dynamicBarcode,
        copies: product.copies || 1,
        scale: {
            value: weight.value,
            unit: weight.unit,
            weightKg: weight.weightKg,
            raw: weight.raw,
        },
    };

    console.log('[scale] Printing label:', printRequest);

    enqueuePrint(() => printProductLabel(printRequest))
        .then(() => console.log('[scale] Label printed successfully.'))
        .catch(error => console.error('[scale] Label printing failed:', error));
}

/*
|--------------------------------------------------------------------------
| Server-Sent Events (SSE) Broadcast Helpers
|--------------------------------------------------------------------------
*/

function broadcastWeight(weightData) {
    const payload = `data: ${JSON.stringify(weightData)}\n\n`;
    sseClients.forEach(client => client.write(payload));
}

app.get('/api/printer/scale/stream', (request, response) => {
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    sseClients.push(response);

    response.write(`data: ${JSON.stringify({ status: 'connected', message: 'Listening for scale data...' })}\n\n`);

    request.on('close', () => {
        sseClients = sseClients.filter(client => client !== response);
    });
});

/*
|--------------------------------------------------------------------------
| Initialize Scale & Event Listeners
|--------------------------------------------------------------------------
*/

async function initializeScale() {
    if (!SCALE_ENABLED) {
        console.log('[scale] Disabled');
        return;
    }

    scale = new ScaleReader({
        device: SCALE_DEVICE,
        baudRate: SCALE_BAUD_RATE,
        dataBits: SCALE_DATA_BITS,
        stopBits: SCALE_STOP_BITS,
        parity: SCALE_PARITY,
        minWeightKg: SCALE_MIN_WEIGHT_KG,
        decimalPlaces: SCALE_DECIMAL_PLACES,
    });

    scale.on('connected', () => {
        console.log(`[scale] Ready: ${SCALE_DEVICE}`);
    });

    scale.on('disconnected', () => {
        console.warn('[scale] Disconnected');
    });

    scale.on('error', error => {
        console.error('[scale]', error.message);
    });

    /*
     * Physical Print Button / Incoming Serial Data Listener
     */
    scale.on('weight', weight => {
        console.log('[scale] Physical print button pressed or data received:', weight);

        lastKnownWeight = weight; // Cache latest weight for UI button

        // 1. Always broadcast live weight update to connected browser tabs via SSE
        // This updates your green digital display in real time while a product is armed
        broadcastWeight({
            type: 'weight_update',
            value: weight.value,
            unit: weight.unit,
            weightKg: weight.weightKg
        });

    });

    try {
        await scale.start();
    } catch (error) {
        console.error(`[scale] Unable to open ${SCALE_DEVICE}:`, error.message);
    }
}

/*
|--------------------------------------------------------------------------
| UI Touch Button Print Endpoint
|--------------------------------------------------------------------------
*/

app.post('/api/printer/scale/print-current', (request, response) => {
    if (!SCALE_ENABLED) {
        return response.status(503).json({ success: false, message: 'Scale integration is disabled.' });
    }

    if (!pendingScaleLabel) {
        return response.status(422).json({ success: false, message: 'No product is currently armed.' });
    }

    if (!lastKnownWeight || lastKnownWeight.weightKg <= 0) {
        return response.status(422).json({ success: false, message: 'No valid weight on scale to print.' });
    }

    // Trigger print using the latest cached weight from the screen
    executePrint(lastKnownWeight);

    return response.json({
        success: true,
        message: 'Label print triggered from UI button.',
        weight: lastKnownWeight.weightKg
    });
});


/*
|--------------------------------------------------------------------------
| Format quantity
|--------------------------------------------------------------------------
*/

function formatScaleQuantity(weight) {
    const kg = Number(weight.weightKg);
    
    if (!Number.isFinite(kg) || kg <= 0) {
        return "0 g";
    }

    // Smart formatting rules matching Laravel's logic:
    if (kg >= 1.0) {
        // If it's a whole number (e.g., 3.000 -> 3), drop decimals. Otherwise trim trailing zeros (e.g., 1.500 -> 1.5)
        const formattedQty = Number.isInteger(kg) ? kg : parseFloat(kg.toFixed(3));
        return `${formattedQty} kg`;
    } else {
        // Convert weights under 1kg into grams (e.g., 0.150 kg -> 150 g, 0.162 kg -> 162 g)
        const grams = Math.round(kg * 1000);
        return `${grams} g`;
    }
}

/*
|--------------------------------------------------------------------------
| Request validation
|--------------------------------------------------------------------------
*/

function validateRequest(
    body
) {
    if (
        !body ||
        typeof body !==
            'object'
    ) {
        return (
            'Request body is required'
        );
    }

    if (
        typeof body.productName !==
            'string' ||
        !body.productName.trim()
    ) {
        return (
            'productName is required'
        );
    }

    if (
        body.quantity ===
            undefined ||
        body.quantity ===
            null ||
        !String(
            body.quantity
        ).trim()
    ) {
        return (
            'quantity is required'
        );
    }

    if (
        typeof body.barcode !==
            'string' ||
        !body.barcode.trim()
    ) {
        return (
            'barcode is required'
        );
    }

    if (
        body.copies !==
        undefined
    ) {
        const copies =
            Number(
                body.copies
            );

        if (
            !Number.isInteger(
                copies
            ) ||
            copies < 1 ||
            copies > 100
        ) {
            return (
                'copies must be an integer ' +
                'between 1 and 100'
            );
        }
    }

    if (
        body.paper
    ) {
        for (
            const property of [
                'widthMm',
                'heightMm',
                'gapMm',
            ]
        ) {
            if (
                body.paper[
                    property
                ] !== undefined
            ) {
                const value =
                    Number(
                        body.paper[
                            property
                        ]
                    );

                if (
                    !Number.isFinite(
                        value
                    ) ||
                    value <= 0
                ) {
                    return (
                        `paper.${property} ` +
                        'must be a positive number'
                    );
                }
            }
        }
    }

    return null;
}

/*
|--------------------------------------------------------------------------
| Printer status
|--------------------------------------------------------------------------
*/

app.get(
    '/api/printer/label/status',
    async (
        request,
        response
    ) => {
        try {
            const connected =
                await deviceExists(
                    CONFIG.device
                );

            let writable =
                false;

            if (connected) {
                try {
                    await checkDevice(
                        CONFIG.device
                    );

                    writable =
                        true;
                } catch {
                    writable =
                        false;
                }
            }

            return response.json({
                printer:
                    'HOLYHAH 3B-365B',

                device:
                    CONFIG.device,

                connected,
                writable,

                configuration: {
                    widthMm:
                        CONFIG.widthMm,

                    heightMm:
                        CONFIG.heightMm,

                    gapMm:
                        CONFIG.gapMm,

                    dpi:
                        CONFIG.dpi,
                },
            });
        } catch (error) {
            return response
                .status(500)
                .json({
                    success:
                        false,

                    message:
                        error.message,
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| Scale status
|--------------------------------------------------------------------------
*/

app.get(
    '/api/printer/scale/status',
    (
        request,
        response
    ) => {
        if (!scale) {
            return response.json({
                enabled:
                    SCALE_ENABLED,

                connected:
                    false,

                device:
                    SCALE_DEVICE,

                pendingLabel:
                    pendingScaleLabel,
            });
        }

        return response.json({
            ...scale.getStatus(),

            pendingLabel:
                pendingScaleLabel,
        });
    }
);

/*
|--------------------------------------------------------------------------
| Prepare a product for scale printing
|--------------------------------------------------------------------------
|
| The POS calls this BEFORE the cashier
| presses PRINT on the Torrey.
|
| Example:
|
| POST /api/printer/scale/prepare
|
| {
|     "productName": "Arroz Super Extra",
|     "barcode": "01234567",
|     "copies": 1
| }
|
|--------------------------------------------------------------------------
*/

app.post(
    '/api/printer/scale/prepare',
    (
        request,
        response
    ) => {
        if (!SCALE_ENABLED) {
            return response
                .status(503)
                .json({
                    success:
                        false,

                    code:
                        'SCALE_DISABLED',

                    message:
                        'Scale integration is disabled.',
                });
        }

        const body =
            request.body;

        if (
            !body ||
            typeof body !==
                'object'
        ) {
            return response
                .status(422)
                .json({
                    success:
                        false,

                    message:
                        'Request body is required',
                });
        }

        if (
            typeof body.productName !==
                'string' ||
            !body.productName.trim()
        ) {
            return response
                .status(422)
                .json({
                    success:
                        false,

                    message:
                        'productName is required',
                });
        }

        if (
            typeof body.barcode !==
                'string' ||
            !body.barcode.trim()
        ) {
            return response
                .status(422)
                .json({
                    success:
                        false,

                    message:
                        'barcode is required',
                });
        }

        const copies =
            body.copies ===
            undefined
                ? 1
                : Number(
                    body.copies
                );

        if (
            !Number.isInteger(
                copies
            ) ||
            copies < 1 ||
            copies > 100
        ) {
            return response
                .status(422)
                .json({
                    success:
                        false,

                    message:
                        'copies must be an integer between 1 and 100',
                });
        }

        pendingScaleLabel = {
            productName:
                body.productName.trim(),

            barcode:
                body.barcode.trim(),

            copies,

            armedAt:
                new Date()
                    .toISOString(),
        };

        console.log(
            '[scale] Product armed:',
            pendingScaleLabel
        );

        return response.json({
            success:
                true,

            message:
                'Product armed. Place the product on the scale and press PRINT.',

            product:
                pendingScaleLabel,
        });
    }
);

/*
|--------------------------------------------------------------------------
| Cancel pending scale print
|--------------------------------------------------------------------------
*/

app.delete(
    '/api/printer/scale/prepare',
    (
        request,
        response
    ) => {
        pendingScaleLabel =
            null;

        return response.json({
            success:
                true,

            message:
                'Pending scale label cancelled.',
        });
    }
);

/*
|--------------------------------------------------------------------------
| Preview
|--------------------------------------------------------------------------
*/

app.post(
    '/api/printer/label/preview',
    async (
        request,
        response
    ) => {
        try {
            const error =
                validateRequest(
                    request.body
                );

            if (error) {
                return response
                    .status(422)
                    .json({
                        success:
                            false,

                        message:
                            error,
                    });
            }

            const {
                layout,
            } =
                await buildProductLabel(
                    request.body
                );

            return response.json({
                success:
                    true,

                layout,
            });
        } catch (error) {
            return response
                .status(422)
                .json({
                    success:
                        false,

                    message:
                        error.message,
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| Normal label print
|--------------------------------------------------------------------------
*/

app.post(
    '/api/printer/label/print',
    async (
        request,
        response
    ) => {
        const validationError =
            validateRequest(
                request.body
            );

        if (validationError) {
            return response
                .status(422)
                .json({
                    success:
                        false,

                    message:
                        validationError,
                });
        }

        try {
            const result =
                await enqueuePrint(
                    () =>
                        printProductLabel(
                            request.body
                        )
                );

            return response.json({
                success:
                    true,

                printer:
                    'HOLYHAH 3B-365B',

                device:
                    CONFIG.device,

                bytesWritten:
                    result.bytesWritten,

                layout:
                    result.layout,
            });
        } catch (error) {
            console.error(
                '[label-printer]',
                error
            );

            if (
                error instanceof
                PrinterError
            ) {
                return response
                    .status(503)
                    .json({
                        success:
                            false,

                        code:
                            error.code,

                        message:
                            error.message,
                    });
            }

            return response
                .status(500)
                .json({
                    success:
                        false,

                    code:
                        'PRINT_FAILED',

                    message:
                        error.message,
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

async function shutdown(
    signal
) {
    console.log(
        `[server] ${signal} received. Shutting down...`
    );

    try {
        if (scale) {
            await scale.stop();
        }
    } catch (error) {
        console.error(
            '[server] Scale shutdown error:',
            error.message
        );
    }

    process.exit(
        0
    );
}

process.on(
    'SIGINT',
    () =>
        shutdown('SIGINT')
);

process.on(
    'SIGTERM',
    () =>
        shutdown('SIGTERM')
);

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

async function start() {
    await initializeScale();

    app.listen(
        PORT,
        HOST,
        () => {
            console.log(
                `Label printer service listening on ` +
                `http://${HOST}:${PORT}`
            );

            console.log(
                `Printer device: ${CONFIG.device}`
            );

            console.log(
                `Default label: ` +
                `${CONFIG.widthMm} x ` +
                `${CONFIG.heightMm} mm`
            );

            console.log(
                `Scale: ` +
                `${SCALE_ENABLED ? 'enabled' : 'disabled'}`
            );

            if (SCALE_ENABLED) {
                console.log(
                    `Scale device: ${SCALE_DEVICE}`
                );

                console.log(
                    `Scale baud rate: ${SCALE_BAUD_RATE}`
                );
            }
        }
    );
}

start()
    .catch(
        error => {
            console.error(
                '[server] Startup failed:',
                error
            );

            process.exit(
                1
            );
        }
    );