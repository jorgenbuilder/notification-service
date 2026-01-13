export const idlFactory = ({ IDL }) => {
  const SubscriptionKeys = IDL.Record({
    'auth' : IDL.Text,
    'p256dh' : IDL.Text,
  });
  const Subscription = IDL.Record({
    'endpoint' : IDL.Text,
    'keys' : SubscriptionKeys,
    'expirationTime' : IDL.Opt(IDL.Nat),
  });
  const NotificationBody = IDL.Record({
    'tag' : IDL.Opt(IDL.Text),
    'url' : IDL.Opt(IDL.Text),
    'title' : IDL.Text,
    'content' : IDL.Text,
  });
  const Notification = IDL.Record({
    'context' : IDL.Record({
      'application' : IDL.Principal,
      'receiver' : IDL.Principal,
    }),
    'subscription' : Subscription,
    'body' : NotificationBody,
  });
  return IDL.Service({
    'deregisterApplication' : IDL.Func([IDL.Principal], [], []),
    'getVapidPublicKey' : IDL.Func([], [IDL.Text], ['query']),
    'hasSubscription' : IDL.Func(
        [IDL.Principal, IDL.Text],
        [IDL.Bool],
        ['query'],
      ),
    'peekQueue' : IDL.Func([], [IDL.Vec(Notification)], ['query']),
    'popQueue' : IDL.Func([IDL.Nat64], [], []),
    'registerApplication' : IDL.Func([IDL.Principal], [], []),
    'reportBrokenSubscriptions' : IDL.Func(
        [
          IDL.Vec(
            IDL.Record({
              'application' : IDL.Principal,
              'endpoint' : IDL.Text,
              'user' : IDL.Principal,
            })
          ),
        ],
        [],
        [],
      ),
    'sendNotifications' : IDL.Func(
        [IDL.Vec(IDL.Tuple(IDL.Principal, NotificationBody))],
        [],
        [],
      ),
    'subscribe' : IDL.Func([IDL.Principal, Subscription], [], []),
    'unsubscribe' : IDL.Func([IDL.Principal, IDL.Text], [], []),
    'unsubscribeAll' : IDL.Func([IDL.Principal], [], []),
  });
};
export const init = ({ IDL }) => { return [IDL.Principal]; };
