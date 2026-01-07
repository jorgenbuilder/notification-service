export const idlFactory = ({ IDL }) => {
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
  const NotificationCanister = IDL.Service({
    'deregisterApplication' : IDL.Func([IDL.Principal], [], ['oneway']),
    'getVapidPublicKey' : IDL.Func([], [IDL.Text], ['query']),
    'hasSubscription' : IDL.Func(
        [IDL.Principal, IDL.Text],
        [IDL.Bool],
        ['query'],
      ),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'peekQueue' : IDL.Func([], [IDL.Vec(Notification)], ['query']),
    'popQueue' : IDL.Func([IDL.Nat], [], []),
    'registerApplication' : IDL.Func([IDL.Principal], [], ['oneway']),
    'reportBrokenSubscriptions' : IDL.Func(
        [IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Principal, IDL.Text))],
        [],
        [],
      ),
    'sendNotifications' : IDL.Func(
        [IDL.Vec(IDL.Tuple(IDL.Principal, NotificationBody))],
        [],
        [],
      ),
    'subscribe' : IDL.Func([IDL.Principal, Subscription], [], ['oneway']),
    'unsubscribe' : IDL.Func([IDL.Principal, IDL.Text], [], ['oneway']),
    'unsubscribeAll' : IDL.Func([IDL.Principal], [], ['oneway']),
  });
  return NotificationCanister;
};
export const init = ({ IDL }) => { return [IDL.Principal]; };
