const CircuitBreaker = require('opossum');
const logger = require('./logger');

const createBreaker = (action, name, customOptions = {}) => {
    const breakerOptions = {
        timeout: customOptions.timeout || 15000,               // Default 15s timeout
        errorThresholdPercentage: customOptions.errorThresholdPercentage || 50,
        resetTimeout: customOptions.resetTimeout || 30000
    };

    const breaker = new CircuitBreaker(action, breakerOptions);

    breaker.on('open', () => {
        logger.warn('CIRCUIT_BREAKER', `${name} API Circuit Breaker OPEN`);
    });

    breaker.on('halfOpen', () => {
        logger.info('CIRCUIT_BREAKER', `${name} API Circuit Breaker HALF_OPEN`);
    });

    breaker.on('close', () => {
        logger.info('CIRCUIT_BREAKER', `${name} API Circuit Breaker CLOSED`);
    });

    breaker.on('fallback', () => {
        logger.warn('CIRCUIT_BREAKER', `${name} API Circuit Breaker tripped, using fallback`);
        return { fallback: true, error: `${name} API currently unavailable` };
    });

    return breaker;
};

// We create wrappers for the Axios requests or other SDK calls
// Often we wrap the exact async function we want to protect.
module.exports = {
    createBreaker
};
