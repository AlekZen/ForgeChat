'use strict';
class NotificationError extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
module.exports={NotificationError};
