'use strict';
class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code; this.status = status; this.details = details;
  }
}
const fail = (code, message, status, details) => { throw new AppError(code, message, status, details); };
module.exports = { AppError, fail };
