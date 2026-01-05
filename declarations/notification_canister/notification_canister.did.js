export const idlFactory = ({ IDL }) => {
  const Subscription = IDL.Record({
    'endpoint' : IDL.Text,
    'keys' : IDL.Record({ 'auth' : IDL.Text, 'p256dh' : IDL.Text }),
    'expirationTime' : IDL.Opt(IDL.Nat),
  });
  const NotificationBody = IDL.Record({
    'url' : IDL.Opt(IDL.Text),
    'title' : IDL.Text,
    'content' : IDL.Text,
  });
  const Notification = IDL.Record({
    'context' : IDL.Tuple(IDL.Principal, IDL.Principal),
    'subscription' : Subscription,
    'body' : NotificationBody,
  });
  const HttpRequest = IDL.Record({
    'url' : IDL.Text,
    'method' : IDL.Text,
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
  });
  const HttpResponse = IDL.Record({
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    'status_code' : IDL.Nat16,
  });
  const NotificationCanister = IDL.Service({
    'collect' : IDL.Func([], [IDL.Vec(Notification)], []),
    'deregisterApplication' : IDL.Func([IDL.Principal], [], ['oneway']),
    'getVapidPublicKey' : IDL.Func([], [IDL.Text], ['query']),
    'hasSubscription' : IDL.Func(
        [IDL.Principal, IDL.Text],
        [IDL.Bool],
        ['query'],
      ),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'isQueueEmpty' : IDL.Func([], [IDL.Bool], ['query']),
    'registerApplication' : IDL.Func([IDL.Principal], [], ['oneway']),
    'reportBrokenSubscription' : IDL.Func(
        [IDL.Principal, IDL.Principal, IDL.Text],
        [],
        [],
      ),
    'sendNotification' : IDL.Func(
        [IDL.Principal, NotificationBody],
        [IDL.Nat],
        [],
      ),
    'subscribe' : IDL.Func([IDL.Principal, Subscription], [], ['oneway']),
    'unsubscribe' : IDL.Func([IDL.Principal, IDL.Text], [], ['oneway']),
    'unsubscribeAll' : IDL.Func([IDL.Principal], [], ['oneway']),
  });
  return NotificationCanister;
};
export const init = ({ IDL }) => { return [IDL.Principal]; };
