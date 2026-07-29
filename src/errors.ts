const CODES: Record<string, [number, string]> = {
  AccessDenied: [403, 'Access Denied'],
  AccessForbidden: [403, 'CORSResponse: This CORS request is not allowed'],
  AuthorizationHeaderMalformed: [400, 'The authorization header is malformed'],
  BadDigest: [400, 'The Content-MD5 you specified did not match what we received'],
  BucketAlreadyExists: [409, 'The requested bucket name is not available'],
  BucketAlreadyOwnedByYou: [409, 'You already own this bucket'],
  BucketNotEmpty: [409, 'The bucket you tried to delete is not empty'],
  EntityTooLarge: [400, 'Your proposed upload exceeds the maximum allowed object size'],
  EntityTooSmall: [400, 'Your proposed upload is smaller than the minimum allowed object size'],
  IllegalVersioningConfigurationException: [400, 'The versioning configuration specified is invalid'],
  IncompleteBody: [400, 'You did not provide the number of bytes specified by the Content-Length HTTP header'],
  InternalError: [500, 'We encountered an internal error. Please try again.'],
  InvalidAccessKeyId: [403, 'The AWS Access Key Id you provided does not exist in our records'],
  InvalidArgument: [400, 'Invalid Argument'],
  InvalidBucketName: [400, 'The specified bucket is not valid'],
  InvalidDigest: [400, 'The Content-MD5 you specified is not valid'],
  InvalidPart: [400, 'One or more of the specified parts could not be found'],
  InvalidPartNumber: [416, 'The requested partnumber is not satisfiable'],
  InvalidPartOrder: [400, 'The list of parts was not in ascending order'],
  InvalidRange: [416, 'The requested range is not satisfiable'],
  InvalidRequest: [400, 'Invalid Request'],
  InvalidTag: [400, 'The tag provided was not valid'],
  MalformedPOSTRequest: [400, 'The body of your POST request is not well-formed multipart/form-data'],
  MalformedPolicy: [400, 'The policy is not in the valid JSON format'],
  NoSuchBucketPolicy: [404, 'The bucket policy does not exist'],
  NoSuchCORSConfiguration: [404, 'The CORS configuration does not exist'],
  NoSuchLifecycleConfiguration: [404, 'The lifecycle configuration does not exist'],
  NoSuchObjectLockConfiguration: [404, 'The object lock configuration does not exist'],
  InvalidBucketState: [409, 'The request is not valid for the current state of the bucket'],
  NoSuchTagSet: [404, 'The TagSet does not exist'],
  NoSuchVersion: [404, 'The specified version does not exist'],
  KeyTooLongError: [400, 'Your key is too long'],
  MalformedXML: [400, 'The XML you provided was not well-formed or did not validate against our published schema'],
  MethodNotAllowed: [405, 'The specified method is not allowed against this resource'],
  MissingContentLength: [411, 'You must provide the Content-Length HTTP header'],
  NoSuchBucket: [404, 'The specified bucket does not exist'],
  NoSuchKey: [404, 'The specified key does not exist'],
  NoSuchUpload: [404, 'The specified multipart upload does not exist'],
  NotImplemented: [501, 'A header you provided implies functionality that is not implemented'],
  PreconditionFailed: [412, 'At least one of the pre-conditions you specified did not hold'],
  QuotaExceeded: [403, 'The bucket quota configured for this bucket has been exceeded'],
  RequestTimeTooSkewed: [403, 'The difference between the request time and the current time is too large'],
  SignatureDoesNotMatch: [403, 'The request signature we calculated does not match the signature you provided'],
  SlowDown: [503, 'Please reduce your request rate'],
  XAmzContentSHA256Mismatch: [400, 'The provided x-amz-content-sha256 header does not match what was computed'],
}

export interface S3ErrorDetail {
  contentRange?: string
  headers?: Record<string, string>
  canonicalRequest?: string
  stringToSign?: string
  statusCode?: number
  bucketName?: string
  key?: string
  [key: string]: unknown
}

export class S3Error extends Error {
  code: string
  statusCode: number
  detail: S3ErrorDetail

  constructor(code: string, message?: string, detail: S3ErrorDetail = {}) {
    const known = CODES[code] ?? [400, code]
    super(message ?? known[1])
    this.name = 'S3Error'
    this.code = code
    this.statusCode = detail.statusCode ?? known[0]
    this.detail = detail
  }
}

export function isS3Error(err: unknown): err is S3Error {
  return err instanceof S3Error
}

export { CODES as ERROR_CODES }
