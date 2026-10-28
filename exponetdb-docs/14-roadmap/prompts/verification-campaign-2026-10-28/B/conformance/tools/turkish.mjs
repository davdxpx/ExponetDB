// Arms the classic Turkish case-folding trap in a process where the OS locale is not installed:
// 'I'.toLowerCase() becomes 'ı' and 'i'.toUpperCase() becomes 'İ'. Used as a preload by the I1 matrix.
String.prototype.toLowerCase = function () { return String.prototype.toLocaleLowerCase.call(this, 'tr') }
String.prototype.toUpperCase = function () { return String.prototype.toLocaleUpperCase.call(this, 'tr') }
