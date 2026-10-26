'use strict';

const TorreyScale =
    require('./torrey-scale');

class ScaleLabelIntegration {
    constructor(options = {}) {
        this.scale =
            options.scale;

        this.printLabel =
            options.printLabel;

        /*
         * Product currently selected by the POS.
         *
         * Example:
         *
         * {
         *     name: 'Arroz Super Extra',
         *     barcode: '01234567'
         * }
         */
        this.activeProduct =
            null;

        this.unsubscribe =
            null;

        this.processing =
            false;
    }

    setProduct(product) {
        if (!product) {
            throw new Error(
                'Product is required'
            );
        }

        if (!product.name) {
            throw new Error(
                'Product name is required'
            );
        }

        if (!product.barcode) {
            throw new Error(
                'Product barcode is required'
            );
        }

        this.activeProduct = {
            name:
                String(product.name),

            barcode:
                String(product.barcode),
        };

        console.log(
            '[SCALE] Active product:',
            this.activeProduct
        );

        return this.activeProduct;
    }

    clearProduct() {
        this.activeProduct =
            null;

        console.log(
            '[SCALE] Active product cleared'
        );
    }

    getProduct() {
        return this.activeProduct;
    }

    async handleWeight(weight) {
        if (this.processing) {
            console.warn(
                '[SCALE] Print already in progress'
            );

            return;
        }

        if (!this.activeProduct) {
            console.warn(
                '[SCALE] Weight received but no product is selected'
            );

            return;
        }

        this.processing = true;

        try {
            const product =
                this.activeProduct;

            console.log(
                '[SCALE] Creating label:',
                {
                    product:
                        product.name,

                    barcode:
                        product.barcode,

                    weight:
                        weight.weight,

                    unit:
                        weight.unit,
                }
            );

            await this.printLabel({
                productName:
                    product.name,

                barcode:
                    product.barcode,

                quantity:
                    weight.weight,

                unit:
                    weight.unit,

                scale:
                    {
                        raw:
                            weight.raw,

                        timestamp:
                            weight.timestamp,
                    },
            });

            console.log(
                '[SCALE] Label printed successfully'
            );

            /*
             * Clear product after successful printing.
             *
             * This prevents the next press of PRINT
             * from accidentally generating another
             * label for the same product.
             */
            this.clearProduct();

        } catch (error) {
            console.error(
                '[SCALE] Label printing failed:',
                error
            );
        } finally {
            this.processing =
                false;
        }
    }

    async start() {
        this.unsubscribe =
            this.scale.onWeight(
                (weight) => {
                    this.handleWeight(
                        weight
                    );
                }
            );

        await this.scale.start();
    }

    async stop() {
        if (this.unsubscribe) {
            this.unsubscribe();

            this.unsubscribe =
                null;
        }

        await this.scale.stop();
    }
}

module.exports =
    ScaleLabelIntegration;