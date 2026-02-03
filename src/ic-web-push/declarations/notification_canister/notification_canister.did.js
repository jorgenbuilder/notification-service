export const idlFactory = ({IDL}) => {
    const RelayerInfo = IDL.Record({
        'relayer': IDL.Principal,
        'description': IDL.Text,
        'lastUpdatedAt': IDL.Nat64,
        'vapid_public_key': IDL.Text,
        'registeredAt': IDL.Nat64,
    });
    const SubscriptionKeys = IDL.Record({
        'auth': IDL.Text,
        'p256dh': IDL.Text,
    });
    const Subscription = IDL.Record({
        'endpoint': IDL.Text,
        'keys': SubscriptionKeys,
        'relayer': IDL.Principal,
        'expirationTime': IDL.Opt(IDL.Nat),
    });
    return IDL.Service({
        'getVapidPublicKey': IDL.Func([IDL.Principal], [IDL.Text], ['query']),
        'hasSubscription': IDL.Func(
            [IDL.Principal, IDL.Text],
            [IDL.Bool],
            ['query'],
        ),
        'listRelayers': IDL.Func([], [IDL.Vec(RelayerInfo)], ['query']),
        'subscribe': IDL.Func([IDL.Principal, Subscription], [], []),
        'unsubscribe': IDL.Func([IDL.Principal, IDL.Text], [], []),
        'unsubscribeAll': IDL.Func([IDL.Principal], [], []),
    });
};
export const init = ({IDL}) => {
    return [];
};
